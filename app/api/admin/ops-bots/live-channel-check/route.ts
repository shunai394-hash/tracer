import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
type ShopifyNode = {
  id: string;
  status?: string | null;
  variants?: { nodes: Array<{ id: string; sku: string | null; price: string | null; inventoryQuantity?: number | null }> };
};

function str(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}
function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function visible(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    if (["1", "true", "visible", "public"].includes(value.toLowerCase())) return true;
    if (["0", "false", "hidden", "private"].includes(value.toLowerCase())) return false;
  }
  return null;
}
async function readListings() {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("channel_listings")
    .select("channel,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status,last_synced_at")
    .in("channel", ["BASE", "base", "Shopify", "shopify", "NEWFIND", "newfind"])
    .order("variant_id", { ascending: true })
    .limit(500);
  if (error) throw new Error("channel_listings_read_failed");
  return (data ?? []) as unknown as Row[];
}

type CanonicalExpected = {
  variantId: string;
  productId: string | null;
  sku: string | null;
  price: number | null;
  stock: number | null;
  shouldBePublic: boolean | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
};

async function readCanonicalExpected(): Promise<Map<string, CanonicalExpected>> {
  const db = createSupabaseAdminClient();
  const [variantsResult, productsResult, offersResult, pricesResult] = await Promise.all([
    db.from("commerce_variants").select("id,product_id,sku,source_variant_key"),
    db.from("commerce_products").select("id,active"),
    db.from("supplier_offers").select("variant_id,supplier_product_id,supplier_variant_id,inventory,unit_cost,shipping_cost,ship_to,tracking_supported,source_status,last_checked_at"),
    db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price"),
  ]);
  if (variantsResult.error || productsResult.error || offersResult.error || pricesResult.error) {
    throw new Error("canonical_expected_read_failed");
  }
  const products = new Map((productsResult.data ?? []).map((row) => [String(row.id), row]));
  const offersById = new Map((offersResult.data ?? []).map((row) => [String(row.id), row]));
  const offersByVariant = new Map<string, typeof offersResult.data>();
  for (const offer of offersResult.data ?? []) {
    const id = str(offer.variant_id);
    if (!id) continue;
    offersByVariant.set(id, [...(offersByVariant.get(id) ?? []), offer]);
  }
  const pricesByVariant = new Map<string, typeof pricesResult.data>();
  for (const price of pricesResult.data ?? []) {
    const id = str(price.variant_id);
    if (!id) continue;
    pricesByVariant.set(id, [...(pricesByVariant.get(id) ?? []), price]);
  }
  const now = Date.now();
  const expected = new Map<string, CanonicalExpected>();
  for (const variant of variantsResult.data ?? []) {
    const variantId = str(variant.id);
    const productId = str(variant.product_id);
    if (!variantId || !productId) continue;
    const product = products.get(productId);
    const offers = offersByVariant.get(variantId) ?? [];
    const prices = pricesByVariant.get(variantId) ?? [];
    const matched = prices.map((price) => ({ price, offer: offersById.get(str(price.supplier_offer_id) ?? "") }))
      .filter((pair) => pair.offer && str(pair.offer.variant_id) === variantId)
      .sort((a, b) => (num(b.price.selling_price) ?? 0) - (num(a.price.selling_price) ?? 0))[0];
    const offer = matched?.offer ?? offers[0] ?? null;
    const price = matched?.price ?? null;
    const checked = offer?.last_checked_at ? Date.parse(String(offer.last_checked_at)) : NaN;
    const fresh = Boolean(offer &&
      str(offer.source_status) === "verified" &&
      str(offer.ship_to) === "JP" &&
      str(offer.supplier_product_id) && str(offer.supplier_variant_id) &&
      (num(offer.unit_cost) ?? 0) > 0 && (num(offer.shipping_cost) ?? 0) > 0 &&
      offer.tracking_supported === true && (num(offer.inventory) ?? 0) > 0 &&
      Number.isFinite(checked) && now - checked >= 0 && now - checked <= 24 * 60 * 60 * 1000);
    const sellingPrice = num(price?.selling_price);
    const margin = sellingPrice && offer && num(offer.unit_cost) !== null && num(offer.shipping_cost) !== null
      ? (sellingPrice - (num(offer.unit_cost) as number) - (num(offer.shipping_cost) as number)) / sellingPrice
      : null;
    expected.set(variantId, {
      variantId, productId,
      sku: str(variant.sku) ?? str(variant.source_variant_key),
      price: sellingPrice,
      stock: num(offer?.inventory),
      shouldBePublic: product?.active === true && fresh && sellingPrice !== null && margin !== null && margin >= 0.5,
      supplierProductId: str(offer?.supplier_product_id),
      supplierVariantId: str(offer?.supplier_variant_id),
    });
  }
  return expected;
}

/**
 * Explicit, bounded live read probe. Call with ?live=1 to avoid making external
 * API calls on routine report requests. Reads only existing external IDs; never
 * searches by title and never writes to a channel or database.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  if (url.searchParams.get("live") !== "1") {
    return NextResponse.json(
      { ok: false, readOnly: true, error: "explicit_live_flag_required", usage: "?live=1" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [rows, canonical] = await Promise.all([readListings(), readCanonicalExpected()]);
    const baseRows = rows.filter((row) => ["base"].includes(String(row.channel ?? "").toLowerCase()) && /^\d+$/.test(str(row.external_product_id) ?? ""));
    const shopifyRows = rows.filter((row) => String(row.channel ?? "").toLowerCase() === "shopify" && Boolean(str(row.external_product_id)));
    const newfindRows = rows.filter((row) => String(row.channel ?? "").toLowerCase() === "newfind");
    const baseSample = baseRows.slice(0, 5);
    const shopifySample = shopifyRows.slice(0, 20);
    const base: Array<Record<string, unknown>> = [];
    const shopify: Array<Record<string, unknown>> = [];
    const errors: Array<{ channel: string; reason: string }> = [];

    if (!isBaseConfigured()) {
      errors.push({ channel: "BASE", reason: "base_oauth_not_configured" });
    } else {
      for (const listing of baseSample) {
        const id = str(listing.external_product_id)!;
        try {
          const item = await getBaseItemDetail(id);
          base.push({
            requestedExternalId: id,
            returnedExternalId: str(item.item_id),
            sku: str(item.identifier),
            price: num(item.price),
            stock: num(item.stock),
            published: visible(item.visible),
            observedAt: new Date().toISOString(),
            identityVerified: str(item.item_id) === id,
            variantId: str(listing.variant_id),
            canonical: canonical.get(str(listing.variant_id) ?? "") ?? null,
          });
        } catch {
          errors.push({ channel: "BASE", reason: "item_read_failed:" + id });
        }
      }
    }

    if (!isShopifyConfigured()) {
      errors.push({ channel: "Shopify", reason: "shopify_admin_api_not_configured" });
    } else {
      const ids = [...new Set(shopifySample.map((row) => str(row.external_product_id)).filter((id): id is string => Boolean(id)))];
      const gids = ids.map((id) => id.startsWith("gid://shopify/") ? id : /^\d+$/.test(id) ? "gid://shopify/Product/" + id : id);
      if (gids.length) {
        try {
          const result = await shopifyGraphQL<{ nodes: Array<ShopifyNode | null> }>(
            "query OpsBotReadOnlyChannelCheck($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status variants(first: 100) { nodes { id sku price inventoryQuantity } } } } }",
            { ids: gids },
          );
          for (const node of result.nodes ?? []) {
            if (!node) continue;
            shopify.push({
              externalProductId: node.id,
              status: node.status ?? null,
              variants: (node.variants?.nodes ?? []).map((variant) => {
                const linked = shopifySample.find((row) =>
                  str(row.external_product_id) === node.id &&
                  str(row.external_variant_id) === variant.id
                );
                const expected = linked ? canonical.get(str(linked.variant_id) ?? "") ?? null : null;
                return {
                  externalVariantId: variant.id,
                  sku: variant.sku,
                  price: num(variant.price),
                  stock: num(variant.inventoryQuantity),
                  variantId: linked ? str(linked.variant_id) : null,
                  canonical: expected,
                  parity: expected ? {
                    skuMatch: Boolean(expected.sku && variant.sku === expected.sku),
                    priceMatch: expected.price !== null && num(variant.price) === expected.price,
                    stockMatch: expected.stock !== null && num(variant.inventoryQuantity) === expected.stock,
                  } : null,
                };
              }),
              observedAt: new Date().toISOString(),
            });
          }
        } catch {
          errors.push({ channel: "Shopify", reason: "product_read_failed" });
        }
      }
    }

    return NextResponse.json({
      ok: errors.length === 0,
      readOnly: true,
      mode: "bounded_live_read",
      limits: { maxBaseItems: 5, maxShopifyProducts: 20, databaseListingRows: 500 },
      samples: {
        BASE: { requested: baseSample.length, verified: base.filter((item) => item.identityVerified === true).length, items: base.map((item) => {
          const expected = item.canonical as CanonicalExpected | null;
          const actual = item as Record<string, unknown>;
          return {
            ...item,
            parity: expected ? {
              skuMatch: Boolean(expected.sku && actual.sku === expected.sku),
              priceMatch: expected.price !== null && actual.price === expected.price,
              stockMatch: expected.stock !== null && actual.stock === expected.stock,
              publicationMatch: expected.shouldBePublic !== null && actual.published === expected.shouldBePublic,
            } : null,
          };
        }) },
        Shopify: { requested: shopifySample.length, returned: shopify.length, products: shopify },
        NEWFIND: { storedRows: newfindRows.length, liveVerification: "not_implemented" },
      },
      paritySummary: {
        BASE: {
          linked: base.filter((item) => Boolean(item.canonical)).length,
          unlinked: base.filter((item) => !item.canonical).length,
          mismatches: base.reduce((count, item) => {
            const p = item.canonical as CanonicalExpected | null;
            if (!p) return count;
            return count + Number(Boolean(p.sku && item.sku !== p.sku))
              + Number(p.price !== null && item.price !== p.price)
              + Number(p.stock !== null && item.stock !== p.stock)
              + Number(p.shouldBePublic !== null && item.published !== p.shouldBePublic);
          }, 0),
        },
        Shopify: {
          linked: shopify.reduce((count, product) => count + (product.variants as Array<Record<string, unknown>>).filter((v) => Boolean(v.canonical)).length, 0),
          unlinked: shopify.reduce((count, product) => count + (product.variants as Array<Record<string, unknown>>).filter((v) => !v.canonical).length, 0),
          mismatches: shopify.reduce((count, product) => count + (product.variants as Array<Record<string, unknown>>).reduce((n, v) => {
            const parity = v.parity as Record<string, boolean> | null;
            return n + (parity ? Object.values(parity).filter((match) => !match).length : 0);
          }, 0), 0),
        },
      },
      errors,
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json(
      { ok: false, readOnly: true, error: "live_channel_check_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
