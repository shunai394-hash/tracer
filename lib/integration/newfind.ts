import "server-only";

import { createHmac } from "node:crypto";
import { getNewfindConfig } from "@/lib/config/env";

function buildUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api/integrations/tracer")) return trimmed;
  return `${trimmed}/api/integrations/tracer`;
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
}> {
  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("newfind_promotion_deliveries")
    .select("listing_id")
    .in("status", ["pending", "failed", "sent"])
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (error) throw new Error(error.message);

  let processed = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const result = await promoteShopListingToNewfind(String(row.listing_id));
    if (result.ackStatus === "processed") processed += 1;
    else if (!result.sent) failed += 1;
  }

  return {
    attempted: data?.length ?? 0,
    processed,
    failed,
  };
}

export async function promoteShopListingToNewfind(
  listingId: string,
): Promise<NewfindPromotionResult> {
  const cfg = getNewfindConfig();
  const id = eventId(listingId);

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

  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const { data: existingDelivery } = await supabase
    .from("newfind_promotion_deliveries")
    .select("status, ack_status, http_status, attempts")
    .eq("listing_id", listingId)
    .maybeSingle();

  if (existingDelivery?.status === "processed" && existingDelivery.ack_status === "processed") {
    return {
      configured: true,
      sent: true,
      eventId: id,
      status: typeof existingDelivery.http_status === "number" ? existingDelivery.http_status : 200,
      ackStatus: "processed",
      detail: "already_processed",
    };
  }

  const { data: listing, error } = await supabase
    .from("shop_listings")
    .select("id, title, description, image_url, selling_price, currency, bestseller_id, product_id")
    .eq("id", listingId)
    .eq("published", true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!listing) {
    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: "published_listing_not_found",
    };
  }

  let productUrl: string | null = null;
  let category: string | null = null;
  let brand: string | null = null;
  if (listing.bestseller_id) {
    const { data: bestseller } = await supabase
      .from("marketplace_bestsellers")
      .select("product_url, category, brand, image_url")
      .eq("id", listing.bestseller_id)
      .maybeSingle();
    productUrl = typeof bestseller?.product_url === "string" ? bestseller.product_url : null;
    category = typeof bestseller?.category === "string" ? bestseller.category : null;
    brand = typeof bestseller?.brand === "string" ? bestseller.brand : null;
  }

  if (!productUrl) {
    return {
      configured: true,
      sent: false,
      eventId: id,
      status: null,
      ackStatus: null,
      detail: "product_url_missing_newfind_requires_url",
    };
  }

  await supabase.from("newfind_promotion_deliveries").upsert({
    listing_id: listingId,
    event_id: id,
    status: "pending",
    attempts: (typeof existingDelivery?.attempts === "number" ? existingDelivery.attempts : 0) + 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: "listing_id" });

  const payload = {
    source: "tracer",
    event_id: id,
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
      discovery_reason: "TRACER sales-test published product",
      selection_score: 100,
      confidence: 0.9,
      source_ref: listing.id,
      source_url: productUrl,
      note: String(listing.description ?? ""),
    },
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", cfg.webhookSecret)
    .update(`${timestamp}.${id}.${rawBody}`, "utf8")
    .digest("hex");

  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Integration-Key": cfg.apiKey || "newfind-tracer",
      "X-Integration-Timestamp": timestamp,
      "X-Integration-Id": id,
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

  const deliveryStatus = ackStatus === "processed"
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
    processed_at: ackStatus === "processed" ? new Date().toISOString() : null,
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
