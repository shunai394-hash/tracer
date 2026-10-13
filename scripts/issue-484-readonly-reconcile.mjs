import { createClient } from "@supabase/supabase-js";
import { attachSupplierCommercialEvidence } from "../lib/market/supplier-commercial-evidence.ts";
import { evaluateShopListingRecord } from "../lib/market/listing-commercial-gate.ts";
import { uniqueRowsByKey } from "../lib/ordering/channel-listing-match.ts";
import { isShopifyConfigured, shopifyGraphQL, toShopifyGid } from "../lib/shopify/admin.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log(JSON.stringify({ db: "unconfigured" }));
  process.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function count(table) {
  const { count: value, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) return { table, error: error.code ?? "query_failed" };
  return { table, count: value };
}

const tables = [
  "products",
  "supplier_listings",
  "shop_listings",
  "shop_orders",
  "shop_order_items",
  "purchase_orders",
  "purchase_order_items",
];
const counts = [];
for (const table of tables) counts.push(await count(table));

const { data: listings, error: listingError } = await supabase
  .from("shop_listings")
  .select("id,currency,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id,published,orderable,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,title,description,image_url,selling_price,source_cost,shipping_cost,contribution_profit,inventory,tracking_available,identity_method,identity_confidence,shopify_product_id,shopify_variant_id,base_item_id")
  .limit(2000);
if (listingError) throw new Error(listingError.code ?? "shop_listings_query_failed");

const evidenced = await attachSupplierCommercialEvidence(supabase, listings ?? []);
const shopifyKeys = uniqueRowsByKey(evidenced, (row) => typeof row.shopify_variant_id === "string" ? row.shopify_variant_id : null);
const baseKeys = uniqueRowsByKey(evidenced, (row) => row.base_item_id === null || row.base_item_id === undefined ? null : String(row.base_item_id));
const optimistic = [];
for (const row of evidenced) {
  const decision = evaluateShopListingRecord(row, true);
  if (decision.eligible) optimistic.push(row);
}
const reasonCounts = {};
for (const row of evidenced) {
  const decision = evaluateShopListingRecord(row, null);
  for (const reason of decision.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
}

let eligibleAfterImage = null;
if (optimistic.length > 0) {
  const { probeListingImage } = await import("../lib/market/probe-listing-image.ts");
  eligibleAfterImage = 0;
  for (const row of optimistic) {
    let imageReachable = false;
    try {
      imageReachable = await probeListingImage(row.image_url);
    } catch {
      imageReachable = false;
    }
    if (evaluateShopListingRecord(row, imageReachable).eligible) eligibleAfterImage += 1;
  }
} else {
  eligibleAfterImage = 0;
}

const currencyPairs = {};
for (const row of evidenced) {
  const selling = typeof row.currency === "string" ? row.currency : "missing";
  const source = typeof row.source_currency === "string" ? row.source_currency : "missing";
  const key = `${selling}/${source}`;
  currencyPairs[key] = (currencyPairs[key] ?? 0) + 1;
}

const external = evidenced.filter((row) => row.shopify_product_id || row.base_item_id);
const shopify = [];
if (external.some((row) => row.shopify_product_id)) {
  if (!isShopifyConfigured()) {
    shopify.push({ state: "unconfigured" });
  } else {
    try {
      // Read-only full-catalog walk. Never call mutation helpers from this audit.
      const catalogProducts = [];
      let after = null;
      let hasNextPage = true;
      let productPages = 0;
      while (hasNextPage) {
        const data = await shopifyGraphQL(`query TracerReadOnlyCatalog($after: String) {
          products(first: 100, after: $after, sortKey: ID) {
            nodes {
              id
              legacyResourceId
              title
              status
              variants(first: 100) {
                nodes {
                  id
                  legacyResourceId
                  sku
                  price
                  inventoryQuantity
                  inventoryItem {
                    tracked
                    inventoryLevels(first: 50) {
                      nodes {
                        location { id name }
                        quantities(names: ["available"]) { name quantity }
                      }
                      pageInfo { hasNextPage }
                    }
                  }
                }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`, { after });
        const connection = data.products;
        catalogProducts.push(...(connection.nodes ?? []));
        hasNextPage = connection.pageInfo?.hasNextPage === true;
        after = connection.pageInfo?.endCursor ?? null;
        productPages += 1;
        if (hasNextPage && !after) throw new Error("shopify_product_pagination_cursor_missing");
        if (productPages > 10000) throw new Error("shopify_product_pagination_safety_limit");
      }

      const normalizeId = (value) => String(value ?? "").replace(/^gid:\/\/shopify\/(?:Product|ProductVariant)\//, "");
      const dbProductIds = new Map();
      const dbVariantIds = new Map();
      for (const row of external) {
        if (row.shopify_product_id) {
          const id = normalizeId(row.shopify_product_id);
          if (!dbProductIds.has(id)) dbProductIds.set(id, []);
          dbProductIds.get(id).push(row);
        }
        if (row.shopify_variant_id) {
          const id = normalizeId(row.shopify_variant_id);
          if (!dbVariantIds.has(id)) dbVariantIds.set(id, []);
          dbVariantIds.get(id).push(row);
        }
      }

      const liveProductIds = new Set(catalogProducts.map((p) => normalizeId(p.legacyResourceId ?? p.id)));
      const liveVariantIds = new Set();
      const positiveInventory = [];
      let variantCount = 0;
      let variantPagesTruncated = 0;
      let locationListsTruncated = 0;
      let missingSkuCount = 0;
      for (const product of catalogProducts) {
        if (product.variants?.pageInfo?.hasNextPage) variantPagesTruncated += 1;
        for (const variant of product.variants?.nodes ?? []) {
          variantCount += 1;
          const variantId = normalizeId(variant.legacyResourceId ?? variant.id);
          liveVariantIds.add(variantId);
          if (!String(variant.sku ?? "").trim()) missingSkuCount += 1;
          if (variant.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage) locationListsTruncated += 1;
          const levels = (variant.inventoryItem?.inventoryLevels?.nodes ?? []).map((level) => ({
            locationId: level.location?.id ?? null,
            location: level.location?.name ?? null,
            available: level.quantities?.find((q) => q.name === "available")?.quantity ?? null,
          }));
          const totalAvailableAcrossReturnedLocations = levels.reduce((sum, level) => sum + (Number.isFinite(level.available) ? level.available : 0), 0);
          if (levels.some((level) => Number.isFinite(level.available) && level.available > 0)) {
            positiveInventory.push({
              productId: normalizeId(product.legacyResourceId ?? product.id),
              variantId,
              title: product.title,
              sku: variant.sku ?? null,
              inventoryQuantity: variant.inventoryQuantity ?? null,
              availableByLocation: levels,
              totalAvailableAcrossReturnedLocations,
              tracked: variant.inventoryItem?.tracked ?? null,
              variantIdentityTruncated: product.variants?.pageInfo?.hasNextPage === true,
              locationIdentityTruncated: variant.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage === true,
            });
          }
        }
      }
      const dbProductsMissingFromShopify = [...dbProductIds.keys()].filter((id) => !liveProductIds.has(id));
      const dbVariantsMissingFromShopify = [...dbVariantIds.keys()].filter((id) => !liveVariantIds.has(id));
      const liveProductsMissingFromDb = catalogProducts.filter((p) => !dbProductIds.has(normalizeId(p.legacyResourceId ?? p.id))).map((p) => ({
        productId: normalizeId(p.legacyResourceId ?? p.id), title: p.title, status: p.status,
      }));
      const dbVariantMatchCount = [...dbVariantIds.keys()].filter((id) => liveVariantIds.has(id)).length;
      shopify.push({
        state: "read_complete",
        productPages,
        catalogProductCount: catalogProducts.length,
        dbLinkedProductIdCount: dbProductIds.size,
        dbLinkedVariantIdCount: dbVariantIds.size,
        matchedDbProductIdCount: [...dbProductIds.keys()].filter((id) => liveProductIds.has(id)).length,
        dbProductsMissingFromShopify,
        dbVariantsMatched: dbVariantMatchCount,
        dbVariantsMissingFromShopify,
        liveProductsMissingFromDbCount: liveProductsMissingFromDb.length,
        liveProductsMissingFromDb: liveProductsMissingFromDb.slice(0, 200),
        liveProductStatuses: catalogProducts.reduce((acc, p) => {
          const status = String(p.status ?? "UNKNOWN");
          acc[status] = (acc[status] ?? 0) + 1;
          return acc;
        }, {}),
        liveVariantCountReturned: variantCount,
        missingSkuCount,
        positiveInventoryVariantCount: positiveInventory.length,
        largestAvailableQuantities: positiveInventory.sort((a, b) => (Number(b.inventoryQuantity) || b.totalAvailableAcrossReturnedLocations) - (Number(a.inventoryQuantity) || a.totalAvailableAcrossReturnedLocations)).slice(0, 100),
        variantPagesTruncated,
        locationListsTruncated,
        note: "inventoryQuantity is Shopify's aggregate variant quantity; per-location available quantities are reported separately. Neither value proves supplier stock or supplier orderability.",
      });
      for (const row of external.filter((item) => item.shopify_product_id)) {
        const gid = toShopifyGid("Product", row.shopify_product_id);
        const found = Boolean(gid && liveProductIds.has(normalizeId(gid)));
        shopify.push({
          listingId: row.id,
          found,
          productId: row.shopify_product_id,
          published: row.published === true,
          orderable: row.orderable === true,
        });
      }
    } catch (error) {
      shopify.push({
        state: "read_failed",
        error: error instanceof Error ? error.message.replace(/(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]").slice(0, 200) : "unknown",
      });
    }
  }
}

const base = [];
const baseToken = process.env.BASE_ACCESS_TOKEN?.trim() || "";
for (const row of external.filter((item) => item.base_item_id)) {
  if (!baseToken) {
    base.push({ listingId: row.id, state: "access_token_absent_refresh_not_attempted" });
    continue;
  }
  try {
    const response = await fetch(`https://api.thebase.in/1/items/detail/${encodeURIComponent(String(row.base_item_id))}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${baseToken}`, Accept: "application/json" },
    });
    if (!response.ok) {
      base.push({ listingId: row.id, state: `http_${response.status}` });
      continue;
    }
    const body = await response.json();
    const item = body.item ?? body;
    base.push({
      listingId: row.id,
      found: true,
      visible: item.visible ?? null,
      stock: item.stock ?? null,
      published: row.published === true,
      orderable: row.orderable === true,
    });
  } catch {
    base.push({ listingId: row.id, state: "read_failed" });
  }
}

console.log(JSON.stringify({
  counts,
  shopListingsRead: evidenced.length,
  currencyPairs,
  ambiguousShopifyVariantIds: shopifyKeys.ambiguousKeys.length,
  ambiguousBaseItemIds: baseKeys.ambiguousKeys.length,
  optimisticEligibleIfImageReachable: optimistic.length,
  eligibleAfterImageProbe: eligibleAfterImage,
  reasonCounts,
  externalListings: external.length,
  shopify,
  base,
  writes: "none",
}, null, 2));
