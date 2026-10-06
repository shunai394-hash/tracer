import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
}

// Public origin of the TRACER storefront. Prefer explicit configuration, then
// Vercel's production URL. The final fallback is the canonical TRACER Vercel
// production alias; this prevents a missing deployment-only env from silently
// starving an otherwise gate-passed NEWFIND delivery.
function tracerSiteOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const configured = explicit || (vercel ? `https://${vercel.replace(/^https?:\/\//, "")}` : "https://tracer-self.vercel.app");
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

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
    const result = await promoteShopListingToNewfind(listingId);
    if (result.ackStatus === "processed" || result.ackStatus === "duplicate") processed += 1;
    else if (!result.sent) failed += 1;
  }

  return { attempted: eligible.length, processed, failed, windowSize: listingIds.length };
}

export async function promoteShopListingToNewfind(listingId: string): Promise<NewfindPromotionResult> {
  const cfg = getNewfindConfig();
  const id = eventId(listingId);
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const { data: listing, error } = await supabase
    .from("shop_listings")
    .select("id, slug, title, description, image_url, selling_price, currency, bestseller_id, product_id, identity_method, identity_confidence, supplier_name, base_item_id, contribution_margin, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons")
    .eq("id", listingId)
    .eq("published", true)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!listing || !hasPassedSalesTestGate(listing)) {
    return { configured: Boolean(cfg.apiUrl && cfg.webhookSecret), sent: false, eventId: id, status: null, ackStatus: null, detail: "sales_test_gate_not_passed" };
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
    .select("status, ack_status, http_status, attempts, lease_until, event_id")
    .eq("listing_id", listingId)
    .maybeSingle();

  if (deliveryReadError) throw new Error(deliveryReadError.message);

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

  const sendEventId = currentStatus === "withdrawn"
    ? `${eventId(listingId)}:republished:${now.getTime()}`
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

  const tracerUrl = await resolveLiveTracerUrl(typeof listing.slug === "string" ? listing.slug : null);
  const productUrl = tracerUrl;
  if (!productUrl) {
    const reason = "tracer_sales_url_not_live";
    await supabase.from("newfind_promotion_deliveries").update({ status: "failed", last_error: reason, last_attempt_at: new Date().toISOString(), lease_until: null, updated_at: new Date().toISOString() }).eq("listing_id", listingId).eq("status", "sending").eq("event_id", sendEventId);
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
