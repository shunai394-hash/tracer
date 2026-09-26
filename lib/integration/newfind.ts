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
  detail: string;
};

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
      detail: "newfind_bridge_not_configured",
    };
  }

  const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
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
      detail: "product_url_missing_newfind_requires_url",
    };
  }

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

  const response = await fetch(buildUrl(cfg.apiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Integration-Key": cfg.apiKey || "newfind-tracer",
      "X-Integration-Timestamp": timestamp,
      "X-Integration-Id": id,
      "X-Integration-Signature": signature,
    },
    body: rawBody,
    cache: "no-store",
  });

  const text = await response.text();
  let detail = text.slice(0, 500);
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    detail = typeof json.detail === "string"
      ? json.detail
      : typeof json.error === "string"
        ? json.error
        : detail;
  } catch {}

  return {
    configured: true,
    sent: response.ok,
    eventId: id,
    status: response.status,
    detail,
  };
}
