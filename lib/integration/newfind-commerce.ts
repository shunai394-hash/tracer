import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadCanonicalCommerceListings, type ShopListing } from "@/lib/shop/store";
import { resolveLiveTracerUrl } from "@/lib/integration/newfind";
import { isMinimumListingPriceEligible, MINIMUM_LISTING_PRICE_JPY } from "@/lib/commerce/minimum-listing-price";
import {
  NEWFIND_COMMERCE_EVENT_TYPE,
  NEWFIND_COMMERCE_LEASE_MS,
  decideNewfindCommerceDelivery,
  initialNewfindCommerceDetail,
  newfindCommerceEventKey,
  readNewfindCommerceDetail,
  newfindCommerceOutcome,
  type NewfindCommerceDecision,
  type NewfindCommerceDetail,
  type NewfindCommerceRow,
} from "@/lib/integration/newfind-commerce-ledger";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
}

export type NewfindCommerceResult = {
  receiverReady: boolean;
  configured: boolean;
  candidates: number;
  alreadyProcessed: number;
  skipped: Record<string, number>;
  attempted: number;
  processed: number;
  failed: Array<{ variantId: string; detail: string }>;
};

/**
 * Sends canonical commerce listings that are live on the TRACER storefront
 * (published on Shopify, fresh verified CJ offer, positive profit) to NEWFIND.
 * Same signing, receiver URL and liveness check as the legacy shop_listings
 * delivery. Only `limit` variants are sent per run; failures back off.
 */
export async function promoteCommerceListingsToNewfind(options: { limit?: number; deadlineAt?: number; variantIds?: string[] } = {}): Promise<NewfindCommerceResult> {
  const cfg = getNewfindConfig();
  const receiverReady = process.env.NEWFIND_TRACER_PROMOTION_RECEIVER_READY?.trim() === "1";
  const configured = Boolean(cfg.apiUrl && cfg.webhookSecret);
  const result: NewfindCommerceResult = { receiverReady, configured, candidates: 0, alreadyProcessed: 0, skipped: {}, attempted: 0, processed: 0, failed: [] };
  if (!receiverReady || !configured) return result;
  const limit = Math.max(1, Math.min(options.limit ?? 2, 10));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;

  const requestedVariantIds = options.variantIds?.length ? new Set(options.variantIds.map((id) => id.trim()).filter(Boolean)) : null;
  const listings = (await loadCanonicalCommerceListings()).filter((listing) =>
    listing.canonicalCommerce &&
    isMinimumListingPriceEligible(listing.sellingPrice) &&
    (!requestedVariantIds || requestedVariantIds.has(listing.id))
  );
  result.candidates = listings.length;
  if (listings.length === 0) return result;

  const db = createSupabaseAdminClient();
  const rows = new Map<string, NewfindCommerceRow>();
  const keys = listings.map((listing) => newfindCommerceEventKey(listing.id));
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await db.from("commerce_events").select("event_key,status,detail").in("event_key", keys.slice(i, i + 100));
    if (error) throw new Error("newfind_commerce_ledger_read_failed:" + error.message);
    for (const row of data ?? []) rows.set(String(row.event_key), { status: String(row.status), detail: row.detail });
  }

  const now = Date.now();
  const sendable: Array<{ listing: ShopListing; decision: Extract<NewfindCommerceDecision, { action: "send" }> }> = [];
  for (const listing of listings) {
    const decision = decideNewfindCommerceDelivery(listing.id, rows.get(newfindCommerceEventKey(listing.id)) ?? null, now);
    if (decision.action === "send") sendable.push({ listing, decision });
    else if (decision.reason === "already_processed") result.alreadyProcessed += 1;
    else result.skipped[decision.reason] = (result.skipped[decision.reason] ?? 0) + 1;
  }
  // Recover known duplicate-key intake failures first: the receiver now has
  // URL-based idempotent recovery, so retrying these old failed deliveries clears
  // the integration backlog instead of letting hundreds of never-sent variants
  // starve the repaired rows.
  const deliveryPriority = (item: typeof sendable[number]) => {
    const lastError = item.decision.detail.lastError ?? "";
    if (item.decision.fromStatus === "failed" && /duplicate key value violates unique constraint|discovery insert failed/i.test(lastError)) return 0;
    if (item.decision.fromStatus === "missing") return 1;
    return 2;
  };
  sendable.sort((a, b) =>
    deliveryPriority(a) - deliveryPriority(b)
    || String(a.decision.detail.lastAttemptAt ?? "").localeCompare(String(b.decision.detail.lastAttemptAt ?? "")));

  const selected = sendable.slice(0, limit);
  const outcomes = await Promise.all(selected.map(async ({ listing, decision }) => {
    if (Date.now() > deadlineAt) return { variantId: listing.id, status: "skipped" as const, detail: "time_budget" };
    try {
      return { variantId: listing.id, ...(await deliverOne(db, cfg, listing, decision)) };
    } catch (error) {
      return { variantId: listing.id, status: "failed" as const, detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
    }
  }));
  for (const outcome of outcomes) {
    if (outcome.status === "skipped") continue;
    result.attempted += 1;
    if (outcome.status === "processed") result.processed += 1;
    else if (outcome.status === "failed") result.failed.push({ variantId: outcome.variantId, detail: outcome.detail });
  }
  return result;
}

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Cfg = ReturnType<typeof getNewfindConfig>;

async function deliverOne(
  db: Db,
  cfg: Cfg,
  listing: ShopListing,
  decision: Extract<NewfindCommerceDecision, { action: "send" }>,
): Promise<{ status: "processed" | "sent" | "failed" | "skipped"; detail: string }> {
  const key = newfindCommerceEventKey(listing.id);
  if (decision.fromStatus === "missing") {
    const { error } = await db.from("commerce_events").upsert({
      event_key: key, event_type: NEWFIND_COMMERCE_EVENT_TYPE, entity_type: "commerce_variant", entity_id: listing.id,
      status: "pending", detail: initialNewfindCommerceDetail(listing.id),
    }, { onConflict: "event_key", ignoreDuplicates: true });
    if (error) throw new Error("newfind_commerce_ledger_insert_failed:" + error.message);
  }
  const fromStatus = decision.fromStatus === "missing" ? "pending" : decision.fromStatus;
  const now = new Date();
  const claimed: NewfindCommerceDetail = {
    ...decision.detail,
    attempts: decision.detail.attempts + 1,
    leaseUntil: new Date(now.getTime() + NEWFIND_COMMERCE_LEASE_MS).toISOString(),
    lastAttemptAt: now.toISOString(),
  };
  let claim = db.from("commerce_events").update({ status: "sending", detail: claimed }).eq("event_key", key).eq("status", fromStatus);
  if (fromStatus === "sending") claim = claim.lt("detail->>leaseUntil", now.toISOString());
  else if (decision.detail.lastAttemptAt) claim = claim.eq("detail->>lastAttemptAt", decision.detail.lastAttemptAt);
  const { data: won, error: claimError } = await claim.select("event_key").maybeSingle();
  if (claimError) throw new Error("newfind_commerce_claim_failed:" + claimError.message);
  if (!won) return { status: "skipped", detail: "newfind_delivery_claim_lost" };

  const finish = async (status: "processed" | "sent" | "failed", patch: Partial<NewfindCommerceDetail>) => {
    const detail: NewfindCommerceDetail = { ...claimed, ...patch, leaseUntil: null };
    const { error } = await db.from("commerce_events").update({ status, detail })
      .eq("event_key", key).eq("status", "sending").eq("detail->>leaseUntil", claimed.leaseUntil as string);
    if (error) throw new Error("newfind_commerce_ledger_update_failed:" + error.message);
  };

  const tracer = await resolveLiveTracerUrl(listing.id);
  if (!tracer.url) {
    const reason = tracer.reason ?? "tracer_sales_url_not_live";
    await finish("failed", { lastError: reason, httpStatus: null, ackStatus: null });
    return { status: "failed", detail: reason };
  }

  const eventId = claimed.eventId;
  const payload = {
    source: "tracer",
    event_id: eventId,
    event_type: "product_candidate",
    event_version: 1,
    occurred_at: now.toISOString(),
    payload: {
      source: "tracer",
      product_name: listing.title,
      product_url: tracer.url,
      canonical_url: tracer.url,
      official_url: tracer.url,
      product_image_url: listing.imageUrl ?? "",
      image_url: listing.imageUrl ?? "",
      price: listing.sellingPrice,
      expected_profit: listing.expectedProfit,
      currency: listing.currency,
      category: "other",
      discovery_reason: `TRACER canonical commerce; supplier=${listing.supplierName}; CJ stock and JP shipping verified within 24h; profit calculated; live on Shopify`,
      tracer_url: tracer.url,
      sales_url: tracer.url,
      tracer_listing_id: listing.id,
      tracer_product_id: listing.productId ?? undefined,
      tracer_published: true,
      sales_test_gate: "passed",
      selection_score: 0,
      confidence: 1,
      source_ref: listing.id,
      source_url: tracer.url,
      note: listing.description ?? "",
    },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", cfg.webhookSecret as string).update(`${timestamp}.${eventId}.${rawBody}`, "utf8").digest("hex");

  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(buildUrl(cfg.apiUrl as string), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Integration-Key": cfg.apiKey || "newfind-tracer",
          "X-Integration-Timestamp": timestamp,
          "X-Integration-Id": eventId,
          "X-Integration-Signature": signature,
        },
        body: rawBody,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  if (!response) {
    // A timeout may still have reached NEWFIND; the retry reuses the same
    // event_id so the receiver answers "duplicate" instead of a second product.
    const detail = lastError instanceof Error ? `newfind_request_failed: ${lastError.message}` : "newfind_request_failed";
    await finish("failed", { lastError: detail.slice(0, 300), httpStatus: null, ackStatus: null });
    return { status: "failed", detail };
  }

  const text = await response.text();
  let detail = text.slice(0, 300);
  let ackStatus: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    ackStatus = typeof json.status === "string" ? json.status : null;
    detail = typeof json.detail === "string" ? json.detail : typeof json.error === "string" ? json.error : detail;
  } catch {}
  const status = newfindCommerceOutcome({ ok: response.ok, status: response.status, ackStatus });
  await finish(status, {
    httpStatus: response.status,
    ackStatus,
    lastError: response.ok ? null : detail.slice(0, 300),
    processedAt: status === "processed" ? new Date().toISOString() : null,
  });
  return { status, detail: status === "failed" ? `http_${response.status}: ${detail}` : ackStatus ?? `http_${response.status}` };
}


export type NewfindMinimumPriceWithdrawResult = {
  enabled: boolean;
  configured: boolean;
  examined: number;
  eligible: number;
  withdrawn: number;
  failed: Array<{ variantId: string; detail: string }>;
};

/**
 * Withdraw already-delivered canonical NEWFIND promotions whose persisted
 * Shopify selling price is below the minimum. This is a bounded, explicit
 * maintenance action; callers must authenticate and request execution.
 */
export async function withdrawBelowMinimumPriceCommercePromotions(options: { limit?: number } = {}): Promise<NewfindMinimumPriceWithdrawResult> {
  const cfg = getNewfindConfig();
  const enabled = process.env.NEWFIND_TRACER_PROMOTION_RECEIVER_READY?.trim() === "1";
  const configured = Boolean(cfg.apiUrl && cfg.webhookSecret);
  const result: NewfindMinimumPriceWithdrawResult = { enabled, configured, examined: 0, eligible: 0, withdrawn: 0, failed: [] };
  if (!enabled || !configured) return result;

  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  const db = createSupabaseAdminClient();
  const { data: lowListings, error: listingError } = await db.from("channel_listings")
    .select("variant_id,selling_price,status")
    .eq("channel", "shopify")
    .lt("selling_price", MINIMUM_LISTING_PRICE_JPY)
    .in("status", ["published", "error"])
    .not("external_product_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(500);
  if (listingError) throw new Error("newfind_minimum_price_listing_read_failed:" + listingError.message);
  const variantIds = [...new Set((lowListings ?? []).map((row) => String(row.variant_id ?? "")).filter(Boolean))];
  result.examined = variantIds.length;
  if (variantIds.length === 0) return result;

  const keys = variantIds.map(newfindCommerceEventKey);
  const { data: events, error: eventError } = await db.from("commerce_events")
    .select("event_key,status,detail")
    .in("event_key", keys);
  if (eventError) throw new Error("newfind_minimum_price_ledger_read_failed:" + eventError.message);
  const eventByKey = new Map((events ?? []).map((row) => [String(row.event_key), row]));
  const targets = variantIds.filter((variantId) => eventByKey.get(newfindCommerceEventKey(variantId))?.status === "processed");
  result.eligible = targets.length;
  const originValue = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tracer-pied-alpha.vercel.app";
  const origin = new URL(originValue);
  if (origin.protocol !== "https:") throw new Error("newfind_minimum_price_site_origin_must_be_https");

  for (const variantId of targets.slice(0, limit)) {
    const key = newfindCommerceEventKey(variantId);
    const event = eventByKey.get(key)!;
    const detail = readNewfindCommerceDetail(variantId, event.detail);
    const withdrawEventId = "tracer-commerce-withdrawn:" + detail.eventId;
    const productUrl = origin.origin + "/shop/" + encodeURIComponent(variantId);
    const rawBody = JSON.stringify({
      source: "tracer",
      event_id: withdrawEventId,
      event_type: "product_withdrawn",
      event_version: 1,
      occurred_at: new Date().toISOString(),
      payload: {
        source: "tracer",
        tracer_listing_id: variantId,
        promotion_event_id: detail.eventId,
        product_urls: [productUrl],
        reason: "minimum_listing_price_below_2500",
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", cfg.webhookSecret as string)
      .update(`${timestamp}.${withdrawEventId}.${rawBody}`, "utf8").digest("hex");
    try {
      const response = await fetch(buildUrl(cfg.apiUrl as string), {
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
      const responseText = await response.text();
      let ackStatus: string | null = null;
      try { ackStatus = (JSON.parse(responseText) as { status?: string }).status ?? null; } catch {}
      if (response.ok && (ackStatus === "processed" || ackStatus === "duplicate")) {
        const { error: saveError } = await db.from("commerce_events").update({
          status: "withdrawn",
          detail: { ...detail, leaseUntil: null, lastError: null, withdrawalEventId: withdrawEventId, withdrawnAt: new Date().toISOString(), withdrawalAckStatus: ackStatus },
        }).eq("event_key", key).eq("status", "processed");
        if (saveError) result.failed.push({ variantId, detail: "withdrawn_but_not_recorded:" + saveError.message });
        else result.withdrawn += 1;
      } else {
        result.failed.push({ variantId, detail: `withdraw_http_${response.status}:${responseText.slice(0, 160)}` });
      }
    } catch (error) {
      result.failed.push({ variantId, detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    }
  }
  return result;
}
