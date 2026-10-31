import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
import { createClient } from "@supabase/supabase-js";
import { findRefusedTitleGroups, planVariantFamily } from "../lib/commerce/variant-family.mjs";
import { missingSaleEvidence } from "../lib/commerce/sale-evidence.ts";

loadEnvConfig(process.cwd());
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://lysavahpadzrhpounjgi.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.log(JSON.stringify({ ok: false, reason: "supabase_service_role_not_configured" }));
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const variants = [];
for (let from = 0; from < 10000; from += 1000) {
  const { data, error } = await db.from("commerce_variants")
    .select("id,product_id,title_ja,sku,attributes,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers(id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,raw_data,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices(supplier_offer_id,calculated_at,currency,selling_price,expected_profit,margin_rate)")
    .eq("commerce_products.active", true)
    .range(from, from + 999);
  if (error) throw new Error("variant_read_failed:" + error.message);
  variants.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}
if (variants.length >= 10000) throw new Error("audit_variant_limit_reached");

const listingByVariant = new Map();
for (const channel of ["base", "shopify"]) {
  for (let from = 0; from < variants.length; from += 500) {
    const ids = variants.slice(from, from + 500).map((row) => row.id);
    if (!ids.length) continue;
    const { data, error } = await db.from("channel_listings")
      .select("variant_id,channel,external_product_id,external_variant_id,external_sku,status,selling_price")
      .eq("channel", channel).in("variant_id", ids);
    if (error) throw new Error(channel + "_listing_read_failed:" + error.message);
    for (const row of data ?? []) listingByVariant.set(channel + ":" + row.variant_id, row);
  }
}

const relationRows = (value) => Array.isArray(value) ? value : value ? [value] : [];
const byProduct = new Map();
const evidenceCounts = {};
for (const row of variants) {
  const product = relationRows(row.commerce_products)[0] ?? {};
  const offers = relationRows(row.supplier_offers);
  const prices = relationRows(row.commerce_prices).sort((a, b) => Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")));
  const price = prices[0] ?? {};
  const offer = offers.find((item) => String(item.id) === String(price.supplier_offer_id)) ?? offers[0] ?? {};
  const raw = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data) ? offer.raw_data : {};
  const nativeIdsValid = offer.supplier_code !== "cj" || (/^\\d{8,}$/.test(String(offer.supplier_product_id ?? "")) && /^\\d{8,}$/.test(String(offer.supplier_variant_id ?? "")));
  const shippingKnown = raw.shippingEstimated !== true && (raw.shippingKnown === true || (raw.shippingKnown === undefined && offer.source_status === "verified" && Number(offer.shipping_cost) > 0));
  const stockKnown = raw.stockKnown === true || (raw.stockKnown === undefined && offer.source_status === "verified");
  const missing = offer.id ? missingSaleEvidence({
    supplierCode: String(offer.supplier_code ?? ""),
    supplierProductId: nativeIdsValid ? String(offer.supplier_product_id ?? "") : null,
    supplierVariantId: nativeIdsValid ? String(offer.supplier_variant_id ?? "") : null,
    variantSku: String(row.sku ?? "") || String(listingByVariant.get("base:" + row.id)?.external_sku ?? listingByVariant.get("shopify:" + row.id)?.external_sku ?? ""),
    sourceStatus: String(offer.source_status ?? ""),
    stockKnown, inventory: Number(offer.inventory), unitCost: Number(offer.unit_cost),
    shippingKnown, shipTo: String(offer.ship_to ?? ""), trackingSupported: offer.tracking_supported === true,
    currency: String(price.currency ?? ""), sellingPrice: Number(price.selling_price), expectedProfit: Number(price.expected_profit),
  }) : ["supplier", "identity", "variant", "stock", "cost", "domestic_shipping", "profit", "verification"];
  if (Number(price.margin_rate) < 0.5) missing.push("profit");
  const uniqueMissing = [...new Set(missing)];
  for (const field of uniqueMissing) evidenceCounts[field] = (evidenceCounts[field] ?? 0) + 1;
  const attributes = row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes) ? row.attributes : {};
  const member = {
    productId: String(row.product_id), variantId: String(row.id),
    supplierProductId: nativeIdsValid ? String(offer.supplier_product_id ?? "") : "",
    supplierVariantId: nativeIdsValid ? String(offer.supplier_variant_id ?? "") : "",
    sku: String(row.sku ?? ""),
    title: String(row.title_ja ?? ""),
    supplierVariantName: String(attributes.supplierVariantName ?? ""),
    sellingPrice: Number(price.selling_price) || 0,
    marginRate: Number(price.margin_rate),
    inventory: Number(offer.inventory) || 0,
    evidenceFresh: false,
    missingEvidence: uniqueMissing,
    existingExternalProductId: String(listingByVariant.get("base:" + row.id)?.external_product_id ?? listingByVariant.get("shopify:" + row.id)?.external_product_id ?? "") || null,
    existingExternalVariantId: String(listingByVariant.get("base:" + row.id)?.external_variant_id ?? listingByVariant.get("shopify:" + row.id)?.external_variant_id ?? "") || null,
    attributes,
  };
  const bucket = byProduct.get(row.product_id) ?? { product, members: [] };
  bucket.members.push(member);
  byProduct.set(row.product_id, bucket);
}

const plans = [];
for (const [productId, bucket] of byProduct) {
  if (bucket.members.length < 2) continue;
  plans.push(planVariantFamily({
    productId, sourceKey: bucket.product?.source_key, productTitle: bucket.product?.title_ja,
    description: bucket.product?.description_ja, imageUrl: bucket.product?.image_url, members: bucket.members,
  }));
}
const ready = plans.filter((plan) => plan.ok);
const blocked = plans.filter((plan) => !plan.ok);
const refused = findRefusedTitleGroups([...byProduct.values()].map((bucket) => ({
  productId: bucket.product?.id, title: bucket.product?.title_ja,
  supplierProductId: bucket.members.find((member) => member.supplierProductId)?.supplierProductId ?? "",
  variantCount: bucket.members.length,
})));

console.log(JSON.stringify({
  ok: true, readOnly: true, activeVariantsRead: variants.length, parentProducts: byProduct.size,
  multiVariantParents: plans.length, readyFamilies: ready.length,
  blockedFamilies: blocked.reduce((counts, plan) => { counts[plan.reason] = (counts[plan.reason] ?? 0) + 1; return counts; }, {}),
  saleEvidenceMissingCounts: evidenceCounts, refusedTitleGroups: refused.length,
  sampleFamilies: ready.slice(0, 27).map((plan) => ({
    productId: plan.productId, title: plan.productTitle, supplierProductId: plan.supplierProductId, axes: plan.axes,
    variations: plan.variations.map((variation) => ({
      variantId: variation.variantId, label: variation.label, supplierVariantId: variation.supplierVariantId,
      base: listingByVariant.get("base:" + variation.variantId) ?? null,
      shopify: listingByVariant.get("shopify:" + variation.variantId) ?? null,
    })),
  })),
}, null, 2));
