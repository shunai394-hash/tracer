import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
import { createClient } from "@supabase/supabase-js";
import { findRefusedTitleGroups, planVariantFamily } from "../lib/commerce/variant-family.mjs";

loadEnvConfig(process.cwd());
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://lysavahpadzrhpounjgi.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.log(JSON.stringify({ ok: false, reason: "supabase_service_role_not_configured" }));
  process.exit(0);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const variants = [];
for (let from = 0; from < 5000; from += 1000) {
  const { data, error } = await db.from("commerce_variants")
    .select("id,product_id,title_ja,commerce_products!inner(id,source_key,title_ja,active),supplier_offers(supplier_product_id,supplier_variant_id),commerce_prices(selling_price,margin_rate,currency)")
    .eq("commerce_products.active", true)
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  variants.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}

const byProduct = new Map();
for (const row of variants) {
  const product = Array.isArray(row.commerce_products) ? row.commerce_products[0] : row.commerce_products;
  const offer = (Array.isArray(row.supplier_offers) ? row.supplier_offers : [row.supplier_offers]).find(Boolean) ?? {};
  const price = (Array.isArray(row.commerce_prices) ? row.commerce_prices : [row.commerce_prices]).find(Boolean) ?? {};
  const bucket = byProduct.get(row.product_id) ?? { product, members: [] };
  bucket.members.push({
    productId: row.product_id,
    variantId: row.id,
    supplierProductId: offer.supplier_product_id ?? "",
    supplierVariantId: offer.supplier_variant_id ?? "",
    title: row.title_ja,
    supplierVariantName: null,
    sellingPrice: Number(price.selling_price) || 0,
    marginRate: Number(price.margin_rate),
    inventory: 0,
    evidenceFresh: false,
    missingEvidence: ["verification"],
  });
  byProduct.set(row.product_id, bucket);
}

const plans = [];
for (const [productId, bucket] of byProduct) {
  if (bucket.members.length < 2) continue;
  plans.push(planVariantFamily({
    productId,
    sourceKey: bucket.product?.source_key,
    productTitle: bucket.product?.title_ja,
    members: bucket.members,
  }));
}
const ready = plans.filter((plan) => plan.ok);
const blocked = plans.filter((plan) => !plan.ok);
const refused = findRefusedTitleGroups([...byProduct.values()].map((bucket) => ({
  productId: bucket.product?.id,
  title: bucket.product?.title_ja,
  supplierProductId: bucket.members.find((member) => member.supplierProductId)?.supplierProductId ?? "",
  variantCount: bucket.members.length,
})));

console.log(JSON.stringify({
  ok: true,
  activeVariantsRead: variants.length,
  parentProducts: byProduct.size,
  multiVariantParents: plans.length,
  readyFamilies: ready.length,
  blockedFamilies: blocked.reduce((counts, plan) => {
    counts[plan.reason] = (counts[plan.reason] ?? 0) + 1;
    return counts;
  }, {}),
  pricedAboveMargin: variants.filter((row) => {
    const price = (Array.isArray(row.commerce_prices) ? row.commerce_prices : [row.commerce_prices]).find(Boolean);
    return Number(price?.margin_rate) >= 0.5 && Number(price?.selling_price) > 0;
  }).length,
  refusedTitleGroups: refused.length,
  sampleFamilies: ready.slice(0, 27).map((plan) => ({
    title: plan.productTitle,
    supplierProductId: plan.supplierProductId,
    axes: plan.axes,
    variations: plan.variations.map((row) => ({ label: row.label, supplierVariantId: row.supplierVariantId })),
  })),
}, null, 2));
