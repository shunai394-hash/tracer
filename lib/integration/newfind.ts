import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
}

// Public origin of the TRACER storefront. NEXT_PUBLIC_SITE_URL wins; on
// Vercel the production domain is provided as VERCEL_PROJECT_PRODUCTION_URL.
function tracerSiteOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return null;
}

// Only hand NEWFIND a TRACER URL that actually serves the product page.
async function resolveLiveTracerUrl(slug: string | null): Promise<string | null> {
  const origin = tracerSiteOrigin();
  if (!origin || !slug) return null;
  const url = `${origin}/shop/${encodeURIComponent(slug)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-tracer-liveness-check": "1" },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? url : null;
  } catch {
    return null;
  }
}

function readSelectionReasons(listing: { selection_reasons?: unknown }): string[] {
  return Array.isArray(listing.selection_reasons) ? listing.selection_reasons.map(String) : [];
}

// "selection_score_72.4" (supply gate) / "quality_score_68.0" (market gate).
function selectionScore(listing: { selection_reasons?: unknown }): number {
  for (const reason of readSelectionReasons(listing)) {
    const match = /^(?:selection|quality)_score_(\d+(?:\.\d+)?)$/.exec(reason);
    if (match) return Math.max(0, Math.min(100, Number(match[1])));
  }
  return 0;
}

function identityConfidence(listing: { identity_confidence?: unknown }): number {
  const value = Number(listing.identity_confidence);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Human-readable TRACER discovery evidence shown with the NEWFIND discovery. */
function discoveryReason(listing: {
  selection_reasons?: unknown;
  identity_method?: unknown;
  supplier_name?: unknown;
  contribution_margin?: unknown;
  base_item_id?: unknown;
}): string {
  const reasons = readSelectionReasons(listing);
  const path = reasons.includes("sales_test_gate:supply")
    ? "supply-first"
    : reasons.includes("sales_test_gate:market")
      ? "marketplace ranking"
      : "sales test";
  const parts = [
    `TRACER discovery via ${path}; passed Sales Test Gate`,
    listing.identity_method ? `identity=${String(listing.identity_method)}` : null,
    listing.supplier_name ? `supplier=${String(listing.supplier_name)}` : null,
    Number.isFinite(Number(listing.contribution_margin))
      ? `margin=${Number(listing.contribution_margin).toFixed(1)}%`
      : null,
    listing.base_item_id ? "listed on BASE" : null,
  ].filter(Boolean);
  return parts.join("; ");
}

function eventId(listingId: string): string {
  return `tracer-shop-listing:${listingId}`;
}

export type NewfindPromotionResult = {
  configured: boolean;
  sent: boolean;
  eventId: string;
  status: number | null;
  ackStatus: string | null;
  detail: string;
};

export async function retryPendingNewfindPromotions(limit = 20): Promise<{
  attempted: number;
  processed: number;
  failed: number;
  /** Deliveries in the oldest-first window considered this run. */
  windowSize: number;
}> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const batch = Math.max(1, Math.min(limit, 100));
  const { data, error } = await supabase
    .from("newfind_promotion_deliveries")
    .select("listing_id")
    .in("status", ["pending", "failed", "sent"])
    .order("updated_at", { ascending: true })
    .limit(500);

  if (error) throw new Error(error.message);

  // Deliveries recorded before the Sales Test Gate existed are kept as-is,
  // but they must not occupy the head of the queue: a rejected row is never
  // updated, so with an oldest-first window it would be retried forever and
  // starve gate-passed listings. Pick only rows whose listing passes now.
  const listingIds = Array.from(new Set((data ?? []).map((row) => String(row.listing_id))));
  const eligible: string[] = [];
  for (let i = 0; i < listingIds.length && eligible.length < batch; i += 100) {
    const chunk = listingIds.slice(i, i + 100);
    const { data: listings, error: listingError } = await supabase
      .from("shop_listings")
      .select("id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons")
      .in("id", chunk)
      .eq("published", true);
    if (listingError) throw new Error(listingError.message);
    const passed = new Set((listings ?? []).filter((row) => hasPassedSalesTestGate(row)).map((row) => String(row.id)));
    for (const id of chunk) {
      if (passed.has(id) && eligible.length < batch) eligible.push(id);
    }
  }

  let processed = 0;
  let failed = 0;
  for (const listingId of eligible) {
    // promoteShopListingToNewfind re-checks the gate itself.
    const result = await promoteShopListingToNewfind(listingId);
    if (result.ackStatus === "processed") processed += 1;
    else if (!result.sent) failed += 1;
  }

  return {
    attempted: eligible.length,
    processed,
    failed,
    windowSize: listingIds.length,
  };
}

export async function promoteShopListingToNewfind(
  listingId: string,
): Promise<NewfindPromotionResult> {
  const cfg = getNewfindConfig();
  const id = eventId(listingId);
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  // Sales Test Gate is the only entry point for NEWFIND promotion.
  // Non-gated listings must not create or mutate NEWFIND delivery state.
  const { data: listing, error } = await supabase
    .from("shop_listings")
    .select("id, slug, title, description, image_url, selling_price, currency, bestseller_id, product_id, identity_method, identity_confidence, supplier_name, base_item_id, contribution_margin, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons")
    .eq("id", listingId)
    .eq("published", true)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  // Re-checked on every call, including retries of existing deliveries.
  // BASE publication moves pipeline_stage to BASE_PUBLISHED; the shared check
  // still recognises the gate provenance so NEWFIND keeps working after BASE.
  if (!listing || !hasPassedSalesTestGate(listing)) {
    return {
      configured: Boolean(cfg.apiUrl && cfg.webhookSecret),
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: "sales_test_gate_not_passed",
    };
  }

  // Persist the delivery even when NEWFIND is temporarily unconfigured.
  // Once configuration is restored, the retry cron can drain this pending
  // row without requiring the source listing to be republished.
  await supabase
    .from("newfind_promotion_deliveries")
    .upsert(
      {
        listing_id: listingId,
        event_id: id,
        status: "pending",
        attempts: 0,
      },
      { onConflict: "listing_id", ignoreDuplicates: true },
    );

  if (!cfg.apiUrl || !cfg.webhookSecret) {
    return {
      configured: false,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: "newfind_bridge_not_configured",
    };
  }

  const { data: existingDelivery, error: deliveryReadError } = await supabase
    .from("newfind_promotion_deliveries")
    .select("status, ack_status, http_status, attempts, lease_until, event_id")
    .eq("listing_id", listingId)
    .maybeSingle();

  if (deliveryReadError) throw new Error(deliveryReadError.message);

  if (existingDelivery?.status === "processed" && (existingDelivery.ack_status === "processed" || existingDelivery.ack_status === "duplicate")) {
    return {
      configured: true,
      sent: true,
      eventId: id,
      status: typeof existingDelivery.http_status === "number" ? existingDelivery.http_status : 200,
      ackStatus: "processed",
      detail: "already_processed",
    };
  }

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
  const currentStatus = existingDelivery?.status ?? "pending";
  const currentLease = existingDelivery?.lease_until
    ? new Date(String(existingDelivery.lease_until))
    : null;

  if (currentStatus === "sending" && currentLease && currentLease.getTime() > now.getTime()) {
    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: "sending",
      detail: "newfind_delivery_in_progress",
    };
  }

  // A listing that was withdrawn from NEWFIND and passed the gate again needs
  // a new event id: NEWFIND dedupes on event_id and would answer "duplicate"
  // for the original promotion, leaving the product withdrawn.
  const sendEventId = currentStatus === "withdrawn"
    ? `${eventId(listingId)}:republished:${now.getTime()}`
    : typeof existingDelivery?.event_id === "string" && existingDelivery.event_id
      ? existingDelivery.event_id
      : id;

  let claimQuery = supabase
    .from("newfind_promotion_deliveries")
    .update({
      status: "sending",
      event_id: sendEventId,
      lease_until: leaseUntil,
      attempts: (typeof existingDelivery?.attempts === "number" ? existingDelivery.attempts : 0) + 1,
      updated_at: now.toISOString(),
    })
    .eq("listing_id", listingId);

  if (currentStatus === "sending") {
    claimQuery = claimQuery
      .eq("status", "sending")
      .lt("lease_until", now.toISOString());
  } else {
    claimQuery = claimQuery.eq("status", currentStatus);
  }

  const { data: claimedDelivery, error: claimError } = await claimQuery
    .select("status, attempts, lease_until")
    .maybeSingle();

  if (claimError) throw new Error(claimError.message);
  if (!claimedDelivery) {
    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: "sending",
      detail: "newfind_delivery_claim_lost",
    };
  }



  let marketUrl: string | null = null;
  let category: string | null = null;
  let brand: string | null = null;
  if (listing.bestseller_id) {
    const { data: bestseller } = await supabase
      .from("marketplace_bestsellers")
      .select("product_url, category, brand, image_url")
      .eq("id", listing.bestseller_id)
      .maybeSingle();
    marketUrl = typeof bestseller?.product_url === "string" ? bestseller.product_url : null;
    category = typeof bestseller?.category === "string" ? bestseller.category : null;
    brand = typeof bestseller?.brand === "string" ? bestseller.brand : null;
  }

  // NEWFIND shows product_url next to TRACER's price and image, so it must be
  // TRACER's own live sales page. The marketplace page (another seller, other
  // price) is sent separately as market_url and never as the product link.
  const tracerUrl = await resolveLiveTracerUrl(
    typeof listing.slug === "string" ? listing.slug : null,
  );
  const productUrl = tracerUrl;

  if (!productUrl) {
    const reason = "tracer_sales_url_not_live";
    await supabase.from("newfind_promotion_deliveries").update({
      status: "failed",
      last_error: reason,
      last_attempt_at: new Date().toISOString(),
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("listing_id", listingId);
    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: reason,
    };
  }

  const payload = {
    source: "tracer",
    event_id: sendEventId,
    event_type: "product_candidate",
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: {
      source: "tracer",
      product_name: String(listing.title),
      product_url: productUrl,
      canonical_url: productUrl,
      official_url: productUrl,
      product_image_url: String(listing.image_url ?? ""),
      image_url: String(listing.image_url ?? ""),
      price: listing.selling_price,
      currency: String(listing.currency ?? "JPY"),
      brand: brand || undefined,
      category: category || "other",
      discovery_reason: discoveryReason(listing),
      tracer_url: tracerUrl,
      sales_url: tracerUrl,
      market_url: marketUrl ?? undefined,
      // Publication attestation: NEWFIND only promotes TRACER products that
      // are published and passed the Sales Test Gate (checked just above).
      tracer_listing_id: listing.id,
      tracer_product_id: listing.product_id ?? undefined,
      tracer_published: true,
      sales_test_gate: "passed",
      selection_score: selectionScore(listing),
      confidence: identityConfidence(listing),
      source_ref: listing.id,
      source_url: productUrl,
      note: String(listing.description ?? ""),
    },
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", cfg.webhookSecret)
    .update(`${timestamp}.${sendEventId}.${rawBody}`, "utf8")
    .digest("hex");

  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Integration-Key": cfg.apiKey || "newfind-tracer",
      "X-Integration-Timestamp": timestamp,
      "X-Integration-Id": sendEventId,
      "X-Integration-Signature": signature,
    },
    body: rawBody,
    cache: "no-store" as const,
  };

  let response: Response | null = null;
  let lastError: unknown = null;

  // NEWFIND deduplicates by event_id, so retrying the same signed event is safe.
  // Keep the retry budget small enough for the 60s bestsellers request.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(buildUrl(cfg.apiUrl), {
        ...request,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
        break;
      }

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }

  if (!response) {
    await supabase.from("newfind_promotion_deliveries").update({
      status: "failed",
      last_error: lastError instanceof Error ? lastError.message : "newfind_request_failed",
      last_attempt_at: new Date().toISOString(),
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("listing_id", listingId);

    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: lastError instanceof Error
        ? `newfind_request_failed: ${lastError.message}`
        : "newfind_request_failed",
    };
  }

  const text = await response.text();
  let detail = text.slice(0, 500);
  let ackStatus: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    ackStatus = typeof json.status === "string" ? json.status : null;
    detail = typeof json.detail === "string"
      ? json.detail
      : typeof json.error === "string"
        ? json.error
        : detail;
  } catch {}

  // "duplicate" means NEWFIND already processed this event_id; treating it
  // as "sent" made the retry cron re-send processed events forever.
  const acknowledged = ackStatus === "processed" || ackStatus === "duplicate";
  const deliveryStatus = acknowledged
    ? "processed"
    : response.ok
      ? "sent"
      : "failed";

  await supabase.from("newfind_promotion_deliveries").update({
    status: deliveryStatus,
    http_status: response.status,
    ack_status: ackStatus,
    last_error: response.ok ? null : detail,
    last_attempt_at: new Date().toISOString(),
    processed_at: acknowledged ? new Date().toISOString() : null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq("listing_id", listingId);

  return {
    configured: true,
    sent: response.ok,
    eventId: id,
    status: response.status,
    ackStatus,
    detail,
  };
}

export type NewfindRescueResult = {
  /** Gate-passed, still-public listings examined. */
  candidates: number;
  /** Of those, how many have a BASE item. */
  onBase: number;
  /** Already processed by NEWFIND (nothing to do). */
  alreadyProcessed: number;
  /** No delivery row yet / pending / failed / sent-but-unacknowledged. */
  undelivered: { missing: number; pending: number; failed: number; sent: number; sending: number };
  attempted: number;
  processed: number;
  stillFailing: Array<{ listingId: string; detail: string }>;
};

/**
 * Rescue listings that passed the Sales Test Gate (and are typically already
 * on BASE) but never reached NEWFIND: no delivery row, or a pending / failed /
 * unacknowledged one. Selection is by Sales Test Gate provenance, never by
 * published=true alone. Delivery stays idempotent: promoteShopListingToNewfind
 * re-checks the gate, skips processed deliveries, honours the sending lease and
 * NEWFIND dedupes on the stable event_id, so this cannot double-post.
 */
export async function rescueUndeliveredGatePassedListings(options: {
  limit?: number;
  deadlineAt?: number;
} = {}): Promise<NewfindRescueResult> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;

  // Two plain filters (one per provenance marker) instead of an or() over a
  // jsonb containment, whose quoting inside or() is easy to get wrong.
  const columns = "id, base_item_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, updated_at";
  const [byReason, byMarker] = await Promise.all([
    supabase.from("shop_listings").select(columns)
      .eq("published", true)
      .eq("pipeline_reason", SALES_TEST_GATE_PASSED)
      .limit(500),
    supabase.from("shop_listings").select(columns)
      .eq("published", true)
      .filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED]))
      .limit(500),
  ]);
  if (byReason.error) throw new Error(byReason.error.message);
  if (byMarker.error) throw new Error(byMarker.error.message);
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(byReason.data ?? []), ...(byMarker.data ?? [])]) {
    byId.set(String(row.id), row as Record<string, unknown>);
  }
  // BASE-listed first (customers can already buy those), then oldest first.
  const listings = Array.from(byId.values()).sort((a, b) =>
    Number(Boolean(b.base_item_id)) - Number(Boolean(a.base_item_id)) ||
    String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")),
  );

  const gated = (listings ?? []).filter((row) => hasPassedSalesTestGate(row));
  const result: NewfindRescueResult = {
    candidates: gated.length,
    onBase: gated.filter((row) => row.base_item_id).length,
    alreadyProcessed: 0,
    undelivered: { missing: 0, pending: 0, failed: 0, sent: 0, sending: 0 },
    attempted: 0,
    processed: 0,
    stillFailing: [],
  };
  if (gated.length === 0) return result;

  const ids = gated.map((row) => String(row.id));
  const deliveries = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: deliveryError } = await supabase
      .from("newfind_promotion_deliveries")
      .select("listing_id, status, ack_status")
      .in("listing_id", ids.slice(i, i + 100));
    if (deliveryError) throw new Error(deliveryError.message);
    for (const row of data ?? []) {
      const processed = row.status === "processed" && (row.ack_status === "processed" || row.ack_status === "duplicate");
      deliveries.set(String(row.listing_id), processed ? "processed" : String(row.status ?? "pending"));
    }
  }

  const targets: string[] = [];
  for (const id of ids) {
    const status = deliveries.get(id) ?? "missing";
    if (status === "processed") {
      result.alreadyProcessed += 1;
      continue;
    }
    const bucket = status in result.undelivered ? status as keyof NewfindRescueResult["undelivered"] : "pending";
    result.undelivered[bucket] += 1;
    targets.push(id);
  }

  for (const listingId of targets.slice(0, limit)) {
    if (Date.now() >= deadlineAt) break;
    result.attempted += 1;
    const delivery = await promoteShopListingToNewfind(listingId).catch((error) => ({
      sent: false,
      ackStatus: null,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (delivery.ackStatus === "processed") result.processed += 1;
    else result.stillFailing.push({ listingId, detail: delivery.detail });
  }
  return result;
}

export type NewfindWithdrawResult = {
  enabled: boolean;
  configured: boolean;
  /** Processed deliveries examined. */
  examined: number;
  /** Of those, listings that are no longer published + gate-passed. */
  stale: number;
  withdrawn: number;
  failed: Array<{ listingId: string; detail: string }>;
};

/**
 * NEWFIND keeps promoting a product after TRACER unpublishes it, because the
 * bridge only ever sent product_candidate. Send product_withdrawn for
 * processed deliveries whose listing is no longer published and gate-passed.
 * NEWFIND moves its matching TRACER-sourced discovery product out of
 * "approved" (to "pending"; nothing is deleted). Opt-in via
 * NEWFIND_WITHDRAW_RECONCILE=1 because it changes existing NEWFIND rows.
 */
export async function withdrawUnpublishedNewfindPromotions(options: { limit?: number } = {}): Promise<NewfindWithdrawResult> {
  const cfg = getNewfindConfig();
  const result: NewfindWithdrawResult = {
    enabled: process.env.NEWFIND_WITHDRAW_RECONCILE?.trim() === "1",
    configured: Boolean(cfg.apiUrl && cfg.webhookSecret),
    examined: 0,
    stale: 0,
    withdrawn: 0,
    failed: [],
  };
  if (!result.enabled || !result.configured) return result;

  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const { data: deliveries, error } = await supabase
    .from("newfind_promotion_deliveries")
    .select("listing_id, event_id")
    .eq("status", "processed")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  result.examined = deliveries?.length ?? 0;
  if (!deliveries || deliveries.length === 0) return result;

  const { data: listings, error: listingError } = await supabase
    .from("shop_listings")
    .select("id, slug, bestseller_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons")
    .in("id", deliveries.map((row) => String(row.listing_id)));
  if (listingError) throw new Error(listingError.message);
  const listingById = new Map((listings ?? []).map((row) => [String(row.id), row]));
  const stale = deliveries.filter((row) => {
    const listing = listingById.get(String(row.listing_id));
    return !listing || listing.published !== true || !hasPassedSalesTestGate(listing);
  });
  result.stale = stale.length;

  const origin = tracerSiteOrigin();
  for (const delivery of stale.slice(0, limit)) {
    const listingId = String(delivery.listing_id);
    const listing = listingById.get(listingId);
    // Every URL this listing could have been promoted under: the TRACER page
    // (current payloads) and the marketplace page (pre-fix payloads).
    const productUrls: string[] = [];
    if (origin && typeof listing?.slug === "string" && listing.slug) {
      productUrls.push(`${origin}/shop/${encodeURIComponent(listing.slug)}`);
    }
    if (listing?.bestseller_id) {
      const { data: bestseller } = await supabase
        .from("marketplace_bestsellers")
        .select("product_url")
        .eq("id", listing.bestseller_id)
        .maybeSingle();
      if (typeof bestseller?.product_url === "string" && bestseller.product_url) productUrls.push(bestseller.product_url);
    }
    if (productUrls.length === 0) {
      result.failed.push({ listingId, detail: "withdraw_product_url_unknown" });
      continue;
    }

    const withdrawEventId = `tracer-shop-listing-withdrawn:${String(delivery.event_id)}`;
    const rawBody = JSON.stringify({
      source: "tracer",
      event_id: withdrawEventId,
      event_type: "product_withdrawn",
      event_version: 1,
      occurred_at: new Date().toISOString(),
      payload: {
        source: "tracer",
        tracer_listing_id: listingId,
        promotion_event_id: delivery.event_id,
        product_urls: productUrls,
        reason: !listing ? "listing_deleted" : listing.published !== true ? "tracer_unpublished" : "sales_test_gate_not_passed",
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", cfg.webhookSecret)
      .update(`${timestamp}.${withdrawEventId}.${rawBody}`, "utf8")
      .digest("hex");
    try {
      const response = await fetch(buildUrl(cfg.apiUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Integration-Key": cfg.apiKey || "newfind-tracer",
          "X-Integration-Timestamp": timestamp,
          "X-Integration-Id": withdrawEventId,
          "X-Integration-Signature": signature,
        },
        body: rawBody,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let ack: string | null = null;
      try { ack = (JSON.parse(text) as { status?: string }).status ?? null; } catch {}
      if (response.ok && (ack === "processed" || ack === "duplicate")) {
        const { error: updateError } = await supabase.from("newfind_promotion_deliveries").update({
          status: "withdrawn",
          ack_status: "withdrawn",
          http_status: response.status,
          last_error: null,
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("listing_id", listingId).eq("status", "processed");
        if (updateError) result.failed.push({ listingId, detail: `withdrawn_but_not_recorded: ${updateError.message}` });
        else result.withdrawn += 1;
      } else {
        result.failed.push({ listingId, detail: `http_${response.status}: ${text.slice(0, 200)}` });
      }
    } catch (sendError) {
      result.failed.push({ listingId, detail: sendError instanceof Error ? sendError.message : String(sendError) });
    }
  }
  return result;
}
