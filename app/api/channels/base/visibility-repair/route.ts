import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { BASE_ITEMS_MAX_PAGES, fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";
import { syncCommerceListings } from "@/lib/commerce/publish";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TRC_SKU = /^TRC-[0-9A-F]{24}$/i;
type Item = Record<string, unknown>;
type Listing = {
  id: string; variant_id: string; external_product_id: string | null;
  external_sku: string | null; selling_price: number | null; status: string | null;
};
type Offer = {
  id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string;
  unit_cost: number; shipping_cost: number; raw_data: Record<string, unknown> | null;
  inventory: number; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null;
};
type Price = { supplier_offer_id: string; calculated_at: string; currency: string; selling_price: number; expected_profit: number; margin_rate: number };
type Product = { title_ja: string | null; description_ja: string | null; image_url: string | null; active: boolean };
type Variant = {
  id: string; source_variant_key: string; title_ja: string | null;
  commerce_products: Product | Product[] | null;
  supplier_offers: Offer[] | Offer | null;
  commerce_prices: Price[] | Price | null;
};
function rows<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
function visible(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}
function safeHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; }
}
function fresh(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= Date.now() + 5 * 60_000 && Date.now() - at <= 24 * 60 * 60_000;
}

/**
 * Repairs only hidden canonical BASE items in exact duplicate-TRC-SKU groups.
 * Read-only by default. Applying uses the existing commerce publisher and then
 * checks live BASE visibility, SKU, stock, and price by a complete snapshot.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });

  const body = await request.json().catch(() => ({})) as { apply?: unknown; limit?: unknown };
  const apply = body.apply === true;
  const requested = Number(body.limit ?? 5);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(10, Math.floor(requested))) : 5;
  const db = createSupabaseAdminClient();

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (!snapshot.complete || !Array.isArray(snapshot.items)) {
      return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_INCOMPLETE", readOnly: !apply }, { status: 502 });
    }
    const items = snapshot.items as Item[];
    const itemsById = new Map<string, Item>();
    const groups = new Map<string, Item[]>();
    for (const item of items) {
      const id = String(item.item_id ?? "").trim();
      if (id) itemsById.set(id, item);
      const sku = String(item.identifier ?? "").trim().toUpperCase();
      if (!TRC_SKU.test(sku)) continue;
      const group = groups.get(sku) ?? [];
      group.push(item);
      groups.set(sku, group);
    }

    const baseListings: Listing[] = [];
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const { data, error } = await db.from("channel_listings")
        .select("id,variant_id,external_product_id,external_sku,selling_price,status")
        .eq("channel", "base").order("id", { ascending: true }).range(offset, offset + 999);
      if (error) throw new Error("BASE_VISIBILITY_REPAIR_LISTINGS_READ_FAILED");
      baseListings.push(...((data ?? []) as Listing[]));
      if ((data ?? []).length < 1000) break;
      if (offset === 19_000) throw new Error("BASE_VISIBILITY_REPAIR_LISTINGS_SCAN_INCOMPLETE");
    }

    const bySku = new Map<string, Listing[]>();
    const byBaseId = new Map<string, Listing[]>();
    for (const listing of baseListings) {
      const sku = String(listing.external_sku ?? "").trim().toUpperCase();
      const skuRows = bySku.get(sku) ?? [];
      if (sku) { skuRows.push(listing); bySku.set(sku, skuRows); }
      const id = String(listing.external_product_id ?? "").trim();
      const idRows = byBaseId.get(id) ?? [];
      if (id) { idRows.push(listing); byBaseId.set(id, idRows); }
    }

    const mappingCandidates: Array<{ listing: Listing; sku: string; itemId: string; currentPrice: number | null; currentStock: number | null }> = [];
    const groupBlockers: Record<string, number> = {};
    const bump = (reason: string) => { groupBlockers[reason] = (groupBlockers[reason] ?? 0) + 1; };
    for (const [sku, group] of groups) {
      if (group.length < 2) continue;
      const ids = group.map((item) => String(item.item_id ?? "").trim()).filter(Boolean);
      if (ids.length !== group.length || new Set(ids).size !== ids.length) { bump("base_item_id_missing_or_duplicate"); continue; }
      if (group.some((item) => visible(item.visible) !== false)) { bump("duplicate_group_contains_visible_or_unknown_item"); continue; }
      const listings = bySku.get(sku) ?? [];
      if (listings.length !== 1) { bump("channel_listing_not_unique"); continue; }
      const listing = listings[0];
      const itemId = String(listing.external_product_id ?? "").trim();
      if (listing.status !== "published") { bump("channel_listing_not_published"); continue; }
      if (!itemId || !ids.includes(itemId)) { bump("canonical_id_not_in_duplicate_group"); continue; }
      if ((byBaseId.get(itemId) ?? []).length !== 1) { bump("canonical_base_id_mapping_not_unique"); continue; }
      const item = itemsById.get(itemId);
      if (!item || String(item.identifier ?? "").trim().toUpperCase() !== sku) { bump("canonical_live_sku_mismatch"); continue; }
      mappingCandidates.push({
        listing, sku, itemId,
        currentPrice: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
        currentStock: Number.isFinite(Number(item.stock)) ? Number(item.stock) : null,
      });
    }

    const variants: Variant[] = [];
    for (let offset = 0; offset < mappingCandidates.length; offset += 50) {
      const ids = mappingCandidates.slice(offset, offset + 50).map((x) => x.listing.variant_id);
      if (!ids.length) continue;
      const { data, error } = await db.from("commerce_variants")
        .select("id,source_variant_key,title_ja,commerce_products!inner(title_ja,description_ja,image_url,active),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,raw_data,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices!inner(supplier_offer_id,calculated_at,currency,selling_price,expected_profit,margin_rate)")
        .in("id", ids).eq("commerce_products.active", true);
      if (error) throw new Error("BASE_VISIBILITY_REPAIR_CANONICAL_EVIDENCE_READ_FAILED");
      variants.push(...((data ?? []) as unknown as Variant[]));
    }
    const variantById = new Map(variants.map((v) => [String(v.id), v]));
    const eligible: Array<{ listing: Listing; sku: string; itemId: string; variantId: string; title: string; canonicalPrice: number; supplierInventory: number; marginRate: number }> = [];
    const rejected: Array<{ sku: string; itemId: string; reason: string }> = [];
    for (const candidate of mappingCandidates) {
      const variant = variantById.get(candidate.listing.variant_id);
      const product = rows(variant?.commerce_products)[0];
      const offers = rows(variant?.supplier_offers);
      const prices = rows(variant?.commerce_prices).sort((a, b) => Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")));
      const price = prices[0];
      const offer = offers.find((x) => String(x.id) === String(price?.supplier_offer_id ?? ""));
      const title = String(variant?.title_ja || product?.title_ja || "").trim();
      const raw = offer?.raw_data && typeof offer.raw_data === "object" ? offer.raw_data : {};
      const shippingKnown = raw.shippingKnown === true ||
        (raw.shippingKnown === undefined && raw.shippingEstimated !== true && offer?.source_status === "verified" && Number(offer?.shipping_cost) > 0);
      const stockKnown = raw.stockKnown === true || (raw.stockKnown === undefined && offer?.source_status === "verified");
      const nativeIdsValid = offer?.supplier_code !== "cj" ||
        (isCanonicalCjNativeId(offer?.supplier_product_id) && isCanonicalCjNativeId(offer?.supplier_variant_id));
      const exactVariant = Boolean(variant && offer && String(variant.source_variant_key) === String(offer.supplier_variant_id));
      const reason = !variant || !product ? "canonical_product_missing" :
        product.active !== true ? "canonical_product_inactive" :
        !isPublishableCatalogTitle(title) || !isJapaneseProductTitle(title) ? "japanese_title_invalid" :
        !safeHttpUrl(product.image_url) ? "product_image_missing_or_invalid" :
        !price || price.currency !== "JPY" || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0 || Number(price.margin_rate) < 0.5 ? "canonical_price_not_profitable_at_50_percent" :
        Number(candidate.listing.selling_price) !== Number(price.selling_price) ? "channel_price_differs_from_canonical" :
        !offer || !nativeIdsValid || !exactVariant || !offer.supplier_product_id || !offer.supplier_variant_id || !Number.isFinite(Number(offer.unit_cost)) || Number(offer.unit_cost) <= 0 ? "supplier_identity_or_cost_invalid" :
        offer.source_status !== "verified" || !fresh(offer.last_checked_at) ? "supplier_evidence_not_fresh_verified" :
        !shippingKnown || !stockKnown || offer.ship_to !== "JP" || offer.tracking_supported !== true || !Number.isFinite(Number(offer.inventory)) || Number(offer.inventory) <= 0 ? "supplier_fulfillment_evidence_invalid" :
        null;
      if (reason) { rejected.push({ sku: candidate.sku, itemId: candidate.itemId, reason }); continue; }
      eligible.push({
        listing: candidate.listing, sku: candidate.sku, itemId: candidate.itemId,
        variantId: candidate.listing.variant_id, title, canonicalPrice: Number(price!.selling_price),
        supplierInventory: Number(offer!.inventory), marginRate: Number(price!.margin_rate),
      });
    }

    const selected = eligible.slice(0, limit);
    if (apply && selected.length > 0) {
      const publishResult = await syncCommerceListings("base", selected.length, false, selected.map((x) => x.variantId));
      const after = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
      if (!after.complete) throw new Error("BASE_VISIBILITY_REPAIR_READBACK_INCOMPLETE");
      const afterById = new Map(after.items.map((item) => [String(item.item_id ?? "").trim(), item as Item]));
      const verified = selected.map((plan) => {
        const item = afterById.get(plan.itemId);
        const liveVisible = visible(item?.visible);
        const livePrice = Number(item?.price);
        const liveStock = Number(item?.stock);
        const liveSku = String(item?.identifier ?? "").trim().toUpperCase();
        const ok = Boolean(item && liveVisible === true && liveSku === plan.sku &&
          Number.isFinite(livePrice) && Math.round(livePrice) === plan.canonicalPrice &&
          Number.isFinite(liveStock) && liveStock > 0);
        return { sku: plan.sku, itemId: plan.itemId, variantId: plan.variantId, ok,
          liveVisible, liveSku, livePrice: Number.isFinite(livePrice) ? livePrice : null,
          liveStock: Number.isFinite(liveStock) ? liveStock : null, expectedPrice: plan.canonicalPrice };
      });
      return NextResponse.json({
        ok: publishResult.failed === 0 && verified.every((x) => x.ok),
        apply: true, readOnly: false, snapshotComplete: true,
        duplicateSkuGroups: groups.size, mappingCandidates: mappingCandidates.length,
        eligibleCandidates: eligible.length, selected: selected.length,
        published: publishResult.published, failed: publishResult.failed,
        publisherResults: publishResult.results, readbackVerified: verified.filter((x) => x.ok).length,
        readbackFailed: verified.filter((x) => !x.ok).length, readback: verified,
        rejected: rejected.slice(0, 25), groupBlockers,
      }, { status: publishResult.failed === 0 && verified.every((x) => x.ok) ? 200 : 207, headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({
      ok: true, apply: false, readOnly: true, snapshotComplete: true,
      scannedBaseItems: items.length, duplicateSkuGroups: [...groups.values()].filter((g) => g.length > 1).length,
      mappingCandidates: mappingCandidates.length, eligibleCandidates: eligible.length,
      selected: selected.map((x) => ({ sku: x.sku, itemId: x.itemId, variantId: x.variantId, currentPrice: x.listing.selling_price, canonicalPrice: x.canonicalPrice, supplierInventory: x.supplierInventory, marginRate: x.marginRate })),
      rejected: rejected.slice(0, 25), groupBlockers,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_VISIBILITY_REPAIR_FAILED";
    return NextResponse.json({ ok: false, error: message.split(":")[0].slice(0, 140), readOnly: !apply }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
