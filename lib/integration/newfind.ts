import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { localizeProductTitle, isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isRetryableRejectedNewfindEvent } from "@/lib/integration/newfind-retry-policy";
import { isMinimumListingPriceEligible } from "@/lib/commerce/minimum-listing-price";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
}

// Public origin of the TRACER storefront. Prefer explicit configuration, then
// the stable production alias. VERCEL_PROJECT_PRODUCTION_URL can resolve to a
// deployment-specific hostname that does not serve the public /shop route.
function tracerSiteOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const configured = explicit || "https://tracer-pied-alpha.vercel.app";
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export async function resolveLiveTracerUrl(slug: string | null): Promise<{ url: string | null; reason: string | null }> {
  const origin = tracerSiteOrigin();
  if (!origin) return { url: null, reason: "tracer_sales_url_origin_missing" };
  if (!slug) return { url: null, reason: "tracer_sales_url_slug_missing" };
  const url = `${origin}/shop/${encodeURIComponent(slug)}`;
  let lastReason = "tracer_sales_url_fetch_failed";

  // Retry transient storefront warm-up/network failures once, but never retry a definitive 4xx.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "x-tracer-liveness-check": "1" },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { url, reason: null };
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        lastReason = `tracer_sales_url_http_${response.status}`;
        if (attempt < 2) continue;
      } else {
        return { url: null, reason: `tracer_sales_url_http_${response.status}` };
      }
    } catch (error) {
      lastReason = error instanceof Error && error.name === "TimeoutError"
        ? "tracer_sales_url_timeout"
        : "tracer_sales_url_fetch_failed";
      if (attempt < 2) continue;
    }
  }
  return { url: null, reason: lastReason };
}


function readSelectionReasons(listing: { selection_reasons?: unknown }): string[] {
  return Array.isArray(listing.selection_reasons) ? listing.selection_reasons.map(String) : [];
}

function selectionScore(listing: { selection_reasons?: unknown }): number {
  for (const reason of readSelectionReasons(listing)) {
    const match = /^(?:selection|quality)_score_(\d+(?:\.\d+)?)$/.exec(reason);
    if (match) return Math.round(Math.max(0, Math.min(100, Number(match[1]))));
  }
  return 0;
}

function identityConfidence(listing: { identity_confidence?: unknown }): number {
  const value = Number(listing.identity_confidence);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function discoveryReason(listing: {
  selection_reasons?: unknown;
  identity_method?: unknown;
  supplier_name?: unknown;
  contribution_margin?: unknown;
  base_item_id?: unknown;
}): string {
  const reasons = readSelectionReasons(listing);
  const path = reasons.includes("sales_test_gate:supply") ? "supply-first" : reasons.includes("sales_test_gate:market") ? "marketplace ranking" : "sales test";
  const parts = [
    `TRACER discovery via ${path}; passed Sales Test Gate`,
    listing.identity_method ? `identity=${String(listing.identity_method)}` : null,
    listing.supplier_name ? `supplier=${String(listing.supplier_name)}` : null,
    Number.isFinite(Number(listing.contribution_margin)) ? `margin=${Number(listing.contribution_margin).toFixed(1)}%` : null,
    listing.base_item_id ? "listed on BASE" : null,
  ].filter(Boolean);
  return parts.join("; ");
}

function eventId(listingId: string): string {
  return `tracer-shop-listing:${listingId}`;
}

export function isNewfindPromotionLedgerSchemaBlocked(value: unknown): boolean {
  const message = String(value ?? "");
  return /Could not find the table ['"]public[.]tracer_promotions['"] in the schema cache/i.test(message)
    || /promotion ledger (?:insert|update) failed:.*tracer_promotions/i.test(message);
}

function isNewfindPromotionReceiverReady(): boolean {
  return process.env.NEWFIND_TRACER_PROMOTION_RECEIVER_READY?.trim() === "1";
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
  windowSize: number;
  schemaBlocked: number;
}> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const batch = Math.max(1, Math.min(limit, 100));
  const { data, error } = await supabase
    .from("newfind_promotion_deliveries")
    .select("listing_id, last_error")
    .in("status", ["pending", "failed", "sent", "sending"])
    .order("updated_at", { ascending: true })
    .limit(500);

  if (error) throw new Error(error.message);

  const receiverReady = isNewfindPromotionReceiverReady();
  const schemaBlockedIds = new Set(
    (data ?? [])
      .filter((row) => !receiverReady && isNewfindPromotionLedgerSchemaBlocked(row.last_error))
      .map((row) => String(row.listing_id)),
  );
  const listingIds = Array.from(new Set((data ?? []).map((row) => String(row.listing_id))))
    .filter((id) => !schemaBlockedIds.has(id));
  if (!receiverReady) {
    return {
      attempted: 0,
      processed: 0,
      failed: 0,
      windowSize: listingIds.length + schemaBlockedIds.size,
      schemaBlocked: schemaBlockedIds.size,
    };
  }
  const eligible: string[] = [];
  const shopifyStatusById = new Map<string, string>();
  for (let i = 0; i < listingIds.length; i += 100) {
    const chunk = listingIds.slice(i, i + 100);
    const { data: listings, error: listingError } = await supabase
      .from("shop_listings")
      .select("id, title, published, archived_at, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, shopify_sync_status")
      .in("id", chunk)
      .is("archived_at", null)
      .eq("published", true);
    if (listingError) throw new Error(listingError.message);
    for (const row of listings ?? []) {
      const id = String(row.id);
      const shopifyStatus = String(row.shopify_sync_status ?? "");
      shopifyStatusById.set(id, shopifyStatus);
      // The TRACER public sales page only exists for Shopify-synced listings.
      // Do not create doomed NEWFIND deliveries for BASE-only or unsynced rows.
      if (shopifyStatus === "synced" && hasPassedSalesTestGate(row)) eligible.push(id);
    }
  }

  // The TRACER product page is intentionally available only for Shopify-synced
  // products. Retry those first so a backlog of unsynced listings cannot starve
  // products that are already live and purchasable.
  eligible.sort((a, b) =>
    Number(shopifyStatusById.get(b) === "synced") - Number(shopifyStatusById.get(a) === "synced"),
  );
  const selected = eligible.slice(0, batch);

  const results = await Promise.all(selected.map(async (listingId) => {
    try {
      return await promoteShopListingToNewfind(listingId);
    } catch (error) {
      return {
        configured: true,
        sent: false,
        eventId: eventId(listingId),
        status: null,
        ackStatus: null,
        detail: error instanceof Error ? error.message : String(error),
      } satisfies NewfindPromotionResult;
    }
  }));
  const processed = results.filter((result) => result.ackStatus === "processed" || result.ackStatus === "duplicate").length;
  const failed = results.filter((result) => !result.sent).length;

  return { attempted: selected.length, processed, failed, windowSize: listingIds.length, schemaBlocked: schemaBlockedIds.size };
}

export async function promoteShopListingToNewfind(listingId: string): Promise<NewfindPromotionResult> {
  const cfg = getNewfindConfig();
  const id = eventId(listingId);
  if (!isNewfindPromotionReceiverReady()) {
    return {
      configured: Boolean(cfg.apiUrl && cfg.webhookSecret),
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: "newfind_promotion_receiver_not_confirmed_ready",
    };
  }
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const { data: listing, error } = await supabase
    .from("shop_listings")
    .select("id, slug, title, description, image_url, selling_price, currency, bestseller_id, product_id, identity_method, identity_confidence, supplier_name, base_item_id, contribution_margin, published, archived_at, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, shopify_sync_status, shopify_product_id, shopify_variant_id, shopify_handle")
    .eq("id", listingId)
    .is("archived_at", null)
    .eq("published", true)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (listing && !isMinimumListingPriceEligible(listing.selling_price)) {
    return { configured: Boolean(cfg.apiUrl && cfg.webhookSecret), sent: false, eventId: id, status: null, ackStatus: null, detail: "minimum_listing_price_below_2500" };
  }

  if (!listing || !hasPassedSalesTestGate(listing)) {
    return { configured: Boolean(cfg.apiUrl && cfg.webhookSecret), sent: false, eventId: id, status: null, ackStatus: null, detail: "sales_test_gate_not_passed" };
  }

  // Do not queue promotions until the public TRACER product page is backed by a live Shopify listing.
  if (listing.shopify_sync_status !== "synced" || !listing.shopify_product_id || !listing.shopify_variant_id || !listing.shopify_handle) {
    return { configured: Boolean(cfg.apiUrl && cfg.webhookSecret), sent: false, eventId: id, status: null, ackStatus: null, detail: "shopify_listing_not_live" };
  }

  const { error: deliveryUpsertError } = await supabase
    .from("newfind_promotion_deliveries")
    .upsert({ listing_id: listingId, event_id: id, status: "pending", attempts: 0 }, { onConflict: "listing_id", ignoreDuplicates: true });
  if (deliveryUpsertError) throw new Error(deliveryUpsertError.message);

  if (!cfg.apiUrl || !cfg.webhookSecret) {
    return { configured: false, sent: false, eventId: id, status: null, ackStatus: null, detail: "newfind_bridge_not_configured" };
  }

  const { data: existingDelivery, error: deliveryReadError } = await supabase
    .from("newfind_promotion_deliveries")
    .select("status, ack_status, http_status, attempts, lease_until, event_id, last_error")
    .eq("listing_id", listingId)
    .maybeSingle();

  if (deliveryReadError) throw new Error(deliveryReadError.message);

  if (!isNewfindPromotionReceiverReady() && isNewfindPromotionLedgerSchemaBlocked(existingDelivery?.last_error)) {
    return { configured: true, sent: false, eventId: id, status: null, ackStatus: null, detail: "newfind_promotion_ledger_schema_blocked" };
  }

  if (existingDelivery?.status === "processed" && (existingDelivery.ack_status === "processed" || existingDelivery.ack_status === "duplicate")) {
    return { configured: true, sent: true, eventId: id, status: typeof existingDelivery.http_status === "number" ? existingDelivery.http_status : 200, ackStatus: "processed", detail: "already_processed" };
  }

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
  const currentStatus = existingDelivery?.status ?? "pending";
  const currentLease = existingDelivery?.lease_until ? new Date(String(existingDelivery.lease_until)) : null;

  if (currentStatus === "sending" && currentLease && currentLease.getTime() > now.getTime()) {
    return { configured: true, sent: false, eventId: id, status: null, ackStatus: "sending", detail: "newfind_delivery_in_progress" };
  }

  const previousError = String(existingDelivery?.last_error ?? "");
  const integerSchemaRetry = currentStatus === "failed"
    && /invalid input syntax for type integer/i.test(previousError)
    && !String(existingDelivery?.event_id ?? "").includes(":schema-retry");
  const ledgerSchemaRetry = (currentStatus === "failed" || currentStatus === "sending")
    && isNewfindPromotionReceiverReady()
    && isNewfindPromotionLedgerSchemaBlocked(previousError);
  const retryRejectedSchemaEvent = integerSchemaRetry || ledgerSchemaRetry;
  const retryRejectedReceiverEvent = currentStatus === "failed" && isRetryableRejectedNewfindEvent(previousError);
  const nextAttempt = (typeof existingDelivery?.attempts === "number" ? existingDelivery.attempts : 0) + 1;
  const sendEventId = currentStatus === "withdrawn"
    ? `${eventId(listingId)}:republished:${now.getTime()}`
    : retryRejectedSchemaEvent
      ? `${eventId(listingId)}:schema-retry:${nextAttempt}`
      : retryRejectedReceiverEvent
        ? `${eventId(listingId)}:receiver-retry:${nextAttempt}`
        : typeof existingDelivery?.event_id === "string" && existingDelivery.event_id ? existingDelivery.event_id : id;

  let claimQuery = supabase
    .from("newfind_promotion_deliveries")
    .update({ status: "sending", event_id: sendEventId, lease_until: leaseUntil, attempts: (typeof existingDelivery?.attempts === "number" ? existingDelivery.attempts : 0) + 1, updated_at: now.toISOString() })
    .eq("listing_id", listingId);

  if (currentStatus === "sending") claimQuery = claimQuery.eq("status", "sending").lt("lease_until", now.toISOString());
  else claimQuery = claimQuery.eq("status", currentStatus);

  const { data: claimedDelivery, error: claimError } = await claimQuery.select("status, attempts, lease_until").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimedDelivery) return { configured: true, sent: false, eventId: id, status: null, ackStatus: "sending", detail: "newfind_delivery_claim_lost" };

  let marketUrl: string | null = null;
  let category: string | null = null;
  let brand: string | null = null;
  if (listing.bestseller_id) {
    const { data: bestseller } = await supabase.from("marketplace_bestsellers").select("product_url, category, brand, image_url").eq("id", listing.bestseller_id).maybeSingle();
    marketUrl = typeof bestseller?.product_url === "string" ? bestseller.product_url : null;
    category = typeof bestseller?.category === "string" ? bestseller.category : null;
    brand = typeof bestseller?.brand === "string" ? bestseller.brand : null;
  }

  // The storefront route explicitly resolves stable listing UUIDs, avoiding
  // URL-encoding ambiguity for Japanese slugs used by external integrations.
  const tracerResolution = await resolveLiveTracerUrl(typeof listing.id === "string" ? listing.id : null);
  const tracerUrl = tracerResolution.url;
  // NEWFIND validates that sales links originate from TRACER. Only publish a
  // TRACER URL after the actual product page passes its liveness check.
  const productUrl = tracerUrl;
  if (!productUrl) {
    const reason = tracerResolution.reason ?? "tracer_sales_url_not_live";
    await supabase.from("newfind_promotion_deliveries").update({ status: "failed", last_error: reason, last_attempt_at: new Date().toISOString(), lease_until: null, updated_at: new Date().toISOString() }).eq("listing_id", listingId).eq("status", "sending").eq("event_id", sendEventId);
    return { configured: true, sent: false, eventId: sendEventId, status: null, ackStatus: null, detail: reason };
  }

  const japaneseProductName = localizeProductTitle(String(listing.title ?? ""));
  if (!japaneseProductName || !isJapaneseProductTitle(japaneseProductName)) {
    const reason = "newfind_japanese_product_title_unavailable";
    await supabase.from("newfind_promotion_deliveries")
      .update({ status: "failed", last_error: reason, last_attempt_at: new Date().toISOString(), lease_until: null, updated_at: new Date().toISOString() })
      .eq("listing_id", listingId).eq("status", "sending").eq("event_id", sendEventId);
    return { configured: true, sent: false, eventId: sendEventId, status: null, ackStatus: null, detail: reason };
  }

  const payload = {
    source: "tracer",
    event_id: sendEventId,
    event_type: "product_candidate",
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: {
      source: "tracer",
      product_name: japaneseProductName,
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
      sales_url: productUrl,
      market_url: marketUrl ?? undefined,
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
  const signature = createHmac("sha256", cfg.webhookSecret).update(`${timestamp}.${sendEventId}.${rawBody}`, "utf8").digest("hex");
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(buildUrl(cfg.apiUrl), { ...request, signal: AbortSignal.timeout(10_000) });
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  if (!response) {
    await supabase.from("newfind_promotion_deliveries").update({ status: "failed", last_error: lastError instanceof Error ? lastError.message : "newfind_request_failed", last_attempt_at: new Date().toISOString(), lease_until: null, updated_at: new Date().toISOString() }).eq("listing_id", listingId).eq("status", "sending").eq("event_id", sendEventId);
    return { configured: true, sent: false, eventId: sendEventId, status: null, ackStatus: null, detail: lastError instanceof Error ? `newfind_request_failed: ${lastError.message}` : "newfind_request_failed" };
  }

  const text = await response.text();
  let detail = text.slice(0, 500);
  let ackStatus: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    ackStatus = typeof json.status === "string" ? json.status : null;
    detail = typeof json.detail === "string" ? json.detail : typeof json.error === "string" ? json.error : detail;
  } catch {}

  const acknowledged = ackStatus === "processed" || ackStatus === "duplicate";
  const deliveryStatus = acknowledged ? "processed" : response.ok ? "sent" : "failed";

  await supabase.from("newfind_promotion_deliveries").update({ status: deliveryStatus, http_status: response.status, ack_status: ackStatus, last_error: response.ok ? null : detail, last_attempt_at: new Date().toISOString(), processed_at: acknowledged ? new Date().toISOString() : null, lease_until: null, updated_at: new Date().toISOString() }).eq("listing_id", listingId).eq("status", "sending").eq("event_id", sendEventId);

  return { configured: true, sent: response.ok, eventId: sendEventId, status: response.status, ackStatus, detail };
}


export type NewfindRescueResult = {
  candidates: number;
  onBase: number;
  alreadyProcessed: number;
  undelivered: { missing: number; pending: number; failed: number; sent: number; sending: number };
  attempted: number;
  processed: number;
  stillFailing: Array<{ listingId: string; detail: string }>;
};

/** Rescue only listings that still pass the canonical Sales Test Gate. */
export async function rescueUndeliveredGatePassedListings(options: {
  limit?: number;
  deadlineAt?: number;
} = {}): Promise<NewfindRescueResult> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const columns = "id, base_item_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, updated_at";

  const [byReason, byMarker] = await Promise.all([
    supabase.from("shop_listings").select(columns).eq("published", true).eq("pipeline_reason", SALES_TEST_GATE_PASSED).limit(500),
    supabase.from("shop_listings").select(columns).eq("published", true).filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED])).limit(500),
  ]);
  if (byReason.error) throw new Error(byReason.error.message);
  if (byMarker.error) throw new Error(byMarker.error.message);

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(byReason.data ?? []), ...(byMarker.data ?? [])]) byId.set(String(row.id), row as Record<string, unknown>);
  const gated = Array.from(byId.values())
    .filter((row) => hasPassedSalesTestGate(row))
    .sort((a, b) =>
      Number(Boolean(b.base_item_id)) - Number(Boolean(a.base_item_id)) ||
      String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")),
    );

  const result: NewfindRescueResult = {
    candidates: gated.length,
    onBase: gated.filter((row) => row.base_item_id).length,
    alreadyProcessed: 0,
    undelivered: { missing: 0, pending: 0, failed: 0, sent: 0, sending: 0 },
    attempted: 0,
    processed: 0,
    stillFailing: [],
  };
  if (!gated.length) return result;

  const ids = gated.map((row) => String(row.id));
  const deliveries = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from("newfind_promotion_deliveries").select("listing_id,status,ack_status").in("listing_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
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
    if (delivery.ackStatus === "processed" || delivery.ackStatus === "duplicate") result.processed += 1;
    else result.stillFailing.push({ listingId, detail: delivery.detail });
  }
  return result;
}
