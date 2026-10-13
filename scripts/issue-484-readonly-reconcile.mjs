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
    const ids = external.map((row) => toShopifyGid("Product", row.shopify_product_id)).filter(Boolean);
    try {
      const data = await shopifyGraphQL(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status } } }`, { ids });
      const nodes = new Map((data.nodes ?? []).filter(Boolean).map((node) => [node.id, node.status]));
      for (const row of external.filter((item) => item.shopify_product_id)) {
        const gid = toShopifyGid("Product", row.shopify_product_id);
        shopify.push({
          listingId: row.id,
          found: Boolean(gid && nodes.has(gid)),
          status: gid ? nodes.get(gid) ?? null : null,
          published: row.published === true,
          orderable: row.orderable === true,
        });
      }
    } catch {
      shopify.push({ state: "read_failed" });
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
