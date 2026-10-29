import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { isNewfindPromotionLedgerSchemaBlocked, promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { isMinimumListingPriceEligible } from "@/lib/commerce/minimum-listing-price";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
}

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

export type NewfindRescueResult = {
  candidates: number;
  onBase: number;
  alreadyProcessed: number;
  undelivered: { missing: number; pending: number; failed: number; sent: number; sending: number; schemaBlocked: number };
  attempted: number;
  processed: number;
  stillFailing: Array<{ listingId: string; detail: string }>;
};

export async function rescueUndeliveredGatePassedListings(options: { limit?: number; deadlineAt?: number } = {}): Promise<NewfindRescueResult> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const columns = "id, title, base_item_id, published, archived_at, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, shopify_sync_status, updated_at";
  const [byReason, byMarker] = await Promise.all([
    supabase.from("shop_listings").select(columns).is("archived_at", null).eq("published", true).eq("pipeline_reason", SALES_TEST_GATE_PASSED).limit(500),
    supabase.from("shop_listings").select(columns).is("archived_at", null).eq("published", true).filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED])).limit(500),
  ]);
  if (byReason.error) throw new Error(byReason.error.message);
  if (byMarker.error) throw new Error(byMarker.error.message);
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(byReason.data ?? []), ...(byMarker.data ?? [])]) byId.set(String(row.id), row as Record<string, unknown>);
  const listings = Array.from(byId.values()).sort((a, b) => Number(b.shopify_sync_status === "synced") - Number(a.shopify_sync_status === "synced") || Number(Boolean(b.base_item_id)) - Number(Boolean(a.base_item_id)) || String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")));
  // NEWFIND's sales URL is the TRACER product landing page, which requires a
  // live Shopify product. BASE-only listings remain queued until Shopify sync
  // succeeds; retrying them here only produces permanent HTTP 404 failures.
  const gated = listings.filter((row) => hasPassedSalesTestGate(row) && row.shopify_sync_status === "synced");
  const result: NewfindRescueResult = { candidates: gated.length, onBase: gated.filter((row) => row.base_item_id).length, alreadyProcessed: 0, undelivered: { missing: 0, pending: 0, failed: 0, sent: 0, sending: 0, schemaBlocked: 0 }, attempted: 0, processed: 0, stillFailing: [] };
  if (gated.length === 0) return result;

  const ids = gated.map((row) => String(row.id));
  const deliveries = new Map<string, { status: string; schemaBlocked: boolean; lastError: string | null; lastAttemptAt: string | null }>();
  const receiverReady = process.env.NEWFIND_TRACER_PROMOTION_RECEIVER_READY?.trim() === "1";
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: deliveryError } = await supabase.from("newfind_promotion_deliveries").select("listing_id, status, ack_status, last_error, last_attempt_at").in("listing_id", ids.slice(i, i + 100));
    if (deliveryError) throw new Error(deliveryError.message);
    for (const row of data ?? []) {
      const processed = row.status === "processed" && (row.ack_status === "processed" || row.ack_status === "duplicate");
      deliveries.set(String(row.listing_id), {
        status: processed ? "processed" : String(row.status ?? "pending"),
        schemaBlocked: !receiverReady && isNewfindPromotionLedgerSchemaBlocked(row.last_error),
        lastError: typeof row.last_error === "string" ? row.last_error : null,
        lastAttemptAt: typeof row.last_attempt_at === "string" ? row.last_attempt_at : null,
      });
    }
  }

  if (!receiverReady) {
    result.undelivered.schemaBlocked = Array.from(deliveries.values()).filter((delivery) => delivery.schemaBlocked).length;
    return result;
  }

  const targets: string[] = [];
  for (const id of ids) {
    const delivery = deliveries.get(id);
    if (delivery?.schemaBlocked) {
      result.undelivered.schemaBlocked += 1;
      continue;
    }
    const status = delivery?.status ?? "missing";
    if (status === "processed") { result.alreadyProcessed += 1; continue; }

    const listing = gated.find((row) => String(row.id) === id);
    const lastError = delivery?.lastError;
    const listingUpdatedAt = Date.parse(String(listing?.updated_at ?? ""));
    const lastAttemptAt = Date.parse(String(delivery?.lastAttemptAt ?? ""));
    const staleSalesUrlFailure =
      status === "failed" &&
      (lastError === "tracer_sales_url_http_404" || lastError === "tracer_sales_url_not_live") &&
      Number.isFinite(listingUpdatedAt) &&
      Number.isFinite(lastAttemptAt) &&
      listingUpdatedAt > lastAttemptAt;
    if (staleSalesUrlFailure) {
      // A prior 404 is terminal for the old listing state, but if the listing
      // was subsequently published/synced, give that exact event one new
      // attempt. The updated_at > last_attempt_at check prevents 5-minute
      // retry loops while the sales page remains unavailable.
      const { error: resetError } = await supabase
        .from("newfind_promotion_deliveries")
        .update({ status: "pending", last_error: null, lease_until: null, updated_at: new Date().toISOString() })
        .eq("listing_id", id)
        .eq("status", "failed")
        .eq("last_error", lastError);
      if (resetError) {
        result.stillFailing.push({ listingId: id, detail: `newfind_delivery_retry_reset_failed: ${resetError.message}` });
        continue;
      }
      result.undelivered.pending += 1;
      targets.push(id);
      continue;
    }

    const bucket = status in result.undelivered ? status as keyof NewfindRescueResult["undelivered"] : "pending";
    result.undelivered[bucket] += 1;
    // retryPendingNewfindPromotions already handles every durable delivery
    // status. Rescue missing rows, plus old sales-URL failures only after the
    // published/synced listing has changed since the previous failed attempt.
    if (status !== "missing") continue;
    targets.push(id);
  }

  for (const listingId of targets.slice(0, limit)) {
    if (Date.now() >= deadlineAt) break;
    result.attempted += 1;
    const delivery = await promoteShopListingToNewfind(listingId).catch((error) => ({ sent: false, ackStatus: null, detail: error instanceof Error ? error.message : String(error) }));
    if (delivery.ackStatus === "processed") result.processed += 1;
    else result.stillFailing.push({ listingId, detail: delivery.detail });
  }
  return result;
}

export type NewfindWithdrawResult = {
  enabled: boolean;
  configured: boolean;
  examined: number;
  stale: number;
  withdrawn: number;
  failed: Array<{ listingId: string; detail: string }>;
};

export async function withdrawUnpublishedNewfindPromotions(options: { limit?: number } = {}): Promise<NewfindWithdrawResult> {
  const cfg = getNewfindConfig();
  const result: NewfindWithdrawResult = { enabled: process.env.NEWFIND_WITHDRAW_RECONCILE?.trim() === "1", configured: Boolean(cfg.apiUrl && cfg.webhookSecret), examined: 0, stale: 0, withdrawn: 0, failed: [] };
  if (!result.enabled || !result.configured) return result;

  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const { data: deliveries, error } = await supabase.from("newfind_promotion_deliveries").select("listing_id, event_id").eq("status", "processed").order("updated_at", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  result.examined = deliveries?.length ?? 0;
  if (!deliveries || deliveries.length === 0) return result;

  const { data: listings, error: listingError } = await supabase.from("shop_listings").select("id, title, slug, bestseller_id, selling_price, published, archived_at, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons").is("archived_at", null).in("id", deliveries.map((row) => String(row.listing_id)));
  if (listingError) throw new Error(listingError.message);
  const listingById = new Map((listings ?? []).map((row) => [String(row.id), row]));
  const stale = deliveries.filter((row) => {
    const listing = listingById.get(String(row.listing_id));
    return !listing || listing.published !== true || !hasPassedSalesTestGate(listing) || !isMinimumListingPriceEligible(listing.selling_price);
  });
  result.stale = stale.length;

  const origin = tracerSiteOrigin();
  for (const delivery of stale.slice(0, limit)) {
    const listingId = String(delivery.listing_id);
    const listing = listingById.get(listingId);
    const productUrls: string[] = [];
    if (origin && typeof listing?.slug === "string" && listing.slug) productUrls.push(`${origin}/shop/${encodeURIComponent(listing.slug)}`);
    if (listing?.bestseller_id) {
      const { data: bestseller } = await supabase.from("marketplace_bestsellers").select("product_url").eq("id", listing.bestseller_id).maybeSingle();
      if (typeof bestseller?.product_url === "string" && bestseller.product_url) productUrls.push(bestseller.product_url);
    }
    if (productUrls.length === 0) { result.failed.push({ listingId, detail: "withdraw_product_url_unknown" }); continue; }

    const withdrawEventId = `tracer-shop-listing-withdrawn:${String(delivery.event_id)}`;
    const rawBody = JSON.stringify({
      source: "tracer",
      event_id: withdrawEventId,
      event_type: "product_withdrawn",
      event_version: 1,
      occurred_at: new Date().toISOString(),
      payload: { source: "tracer", tracer_listing_id: listingId, promotion_event_id: delivery.event_id, product_urls: productUrls, reason: !listing ? "listing_deleted" : listing.published !== true ? "tracer_unpublished" : !isMinimumListingPriceEligible(listing.selling_price) ? "minimum_listing_price_below_2500" : "sales_test_gate_not_passed" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", cfg.webhookSecret).update(`${timestamp}.${withdrawEventId}.${rawBody}`, "utf8").digest("hex");
    try {
      const response = await fetch(buildUrl(cfg.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "X-Integration-Key": cfg.apiKey || "newfind-tracer", "X-Integration-Timestamp": timestamp, "X-Integration-Id": withdrawEventId, "X-Integration-Signature": signature },
        body: rawBody,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let ack: string | null = null;
      try { ack = (JSON.parse(text) as { status?: string }).status ?? null; } catch {}
      if (response.ok && (ack === "processed" || ack === "duplicate")) {
        const { error: updateError } = await supabase.from("newfind_promotion_deliveries").update({ status: "withdrawn", ack_status: "withdrawn", http_status: response.status, last_error: null, last_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("listing_id", listingId).eq("status", "processed");
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
