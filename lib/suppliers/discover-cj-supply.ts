import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import {
  fetchCJProductVariants,
  fetchCJVariantStock,
  getCJProductDetail,
  searchCJProducts,
  calculateCJFreight,
} from "@/lib/sources/cj";
import { selectUnambiguousVariant } from "@/lib/sources/cj/variant-select";

function yenPrice(costUsd: number, shippingUsd: number, fx: number): number {
  const landed = (costUsd + shippingUsd) * fx;
  const withMargin = Math.max(1980, landed * 2.5);
  return Math.ceil(withMargin / 100) * 100;
}

function slug(title: string, productId: string, variantId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54);
  return `${base || "tracer-product"}-${productId.slice(-8)}-${variantId.slice(-8)}`;
}

/**
 * Supply-first path. This deliberately does not claim marketplace identity.
 * The CJ product/variant itself is the source of truth for the sellable item.
 * Every published row must have a live variant id, live stock > 0, live
 * Japan freight, a positive cost and a non-empty image.
 */
export async function discoverAndCreateCjSupply(limit = 1): Promise<{
  discovered: number;
  published: number;
  rejected: number;
  items: Array<Record<string, unknown>>;
}> {
  const db = createSupabaseAdminClient();
  const fx = await getObservedUsdToJpyRate();
  const fxRate = fx?.rate ?? null;
  if (!fxRate || !Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error("USD/JPY FX rate unavailable");
  }

  const queries = ["beauty", "home storage", "kitchen", "pet", "women"];
  const items: Array<Record<string, unknown>> = [];
  let discovered = 0;
  let published = 0;
  let rejected = 0;

  // Reuse previously discovered CJ IDs first. These rows are only candidates;
  // stock, variant and Japan freight are re-verified live before publication.
  const { data: seededRows } = await db
    .from("supplier_listings")
    .select("title,supplier_product_id,supplier_variant_id,cost")
    .eq("supplier", "cj")
    .eq("inventory_confirmed", true)
    .eq("price_confirmed", true)
    .gt("inventory", 0)
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .order("inventory", { ascending: false })
    .limit(12);

  const seeded = (seededRows ?? []).filter((row, index, rows) =>
    rows.findIndex((x) => x.supplier_product_id === row.supplier_product_id && x.supplier_variant_id === row.supplier_variant_id) === index
  );

  const candidateInputs = (seeded.length
    ? seeded.map((row) => ({
        query: "seeded",
        id: String(row.supplier_product_id),
        variantId: String(row.supplier_variant_id),
      }))
    : [
        {
          query: "bootstrap-observed",
          id: "1522412448668725248",
          variantId: "1522412448823914496",
        },
      ]);

  for (const seededCandidate of candidateInputs) {
    if (published >= limit) break;
    const candidate = {
      id: seededCandidate.id,
      variantId: seededCandidate.variantId,
      title: "seeded",
      imageUrl: null,
      price: null,
    };
    const query = seededCandidate.query;
    try {
      const detail = await getCJProductDetail(candidate.id);
      if (!detail?.imageUrl || !detail.title) continue;
      const variants = await fetchCJProductVariants(candidate.id, { countryCode: "JP" });
      const variant = variants.find((x) => x.vid === candidate.variantId) ?? null;
      if (!variant?.vid) continue;
      const stock = await fetchCJVariantStock(variant.vid);
      if (stock === null || stock <= 0) continue;
      const freight = await calculateCJFreight(variant.vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 });
      if (freight === null || freight <= 0) continue;
      const cost = Number(variant.sellPrice ?? detail.price);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const salePrice = yenPrice(cost, freight, fxRate);
      const sourceRef = `cj:${candidate.id}:${variant.vid}`;
      const productInsert = await db.from("products").upsert({ canonical_name: detail.title, identity_key: sourceRef }, { onConflict: "identity_key" }).select("id").single();
      if (productInsert.error) throw new Error(productInsert.error.message);
      const productId = String(productInsert.data.id);
      const supplierInsert = await db.from("supplier_listings").upsert({
        supplier: "cj", external_id: variant.vid, sku: variant.sku, title: detail.title, product_id: productId,
        cost, shipping_cost: freight, currency: "USD", inventory: Math.floor(stock), ship_to: "JP",
        order_method: "cj_api", api_available: true, identity_method: "supply_discovered",
        identity_status: "supply_discovered", identity_confidence: 1, configured: true,
        supplier_product_id: candidate.id, supplier_variant_id: variant.vid, cj_variant_id: variant.vid,
        orderable: true, price_confirmed: true, inventory_confirmed: true, tracking_available: false,
        fetched_at: new Date().toISOString(), metadata: { source: "cj_supply_first", source_ref: sourceRef, query, fx_rate: fxRate }
      }, { onConflict: "supplier,external_id" }).select("id").single();
      if (supplierInsert.error) throw new Error(supplierInsert.error.message);
      const listingSlug = slug(detail.title, candidate.id, variant.vid);
      const shopInsert = await db.from("shop_listings").upsert({
        product_id: productId, supplier_listing_id: supplierInsert.data.id, slug: listingSlug, title: detail.title,
        description: `TRACER supply-first product. Supplier: CJdropshipping. Variant: ${variant.nameEn ?? "standard"}.`,
        image_url: detail.imageUrl, selling_price: salePrice, currency: "JPY", supplier_name: "cj",
        supplier_product_id: candidate.id, supplier_variant_id: variant.vid, source_cost: cost, shipping_cost: freight,
        inventory: Math.floor(stock), orderable: true, tracking_available: false, identity_method: "supply_discovered",
        identity_confidence: 1, published: true, selection_reasons: ["supply_first","live_cj_variant","live_inventory_gt_zero","live_japan_freight",`fx_usdjpy_${fxRate.toFixed(4)}`],
        missing: [], published_at: new Date().toISOString(), pipeline_stage: "PUBLISHED", pipeline_status: "published",
        pipeline_reason: "supply_first_gate_passed", pipeline_updated_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }, { onConflict: "slug" }).select("id").single();
      if (shopInsert.error) throw new Error(shopInsert.error.message);
      discovered++; published++;
      items.push({ listingId: String(shopInsert.data.id), productId, supplierListingId: String(supplierInsert.data.id), title: detail.title, supplierProductId: candidate.id, supplierVariantId: variant.vid, costUsd: cost, freightUsd: freight, inventory: Math.floor(stock), sellingPriceJpy: salePrice, fxRate });
    } catch (error) {
      rejected++;
      console.warn("[supply-first] seeded candidate rejected", { productId: candidate.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (published >= limit) return { discovered, published, rejected, items };

  for (const query of queries) {
    if (published >= limit) break;

    if (candidateInputs.length > 0) break;
    let search;
    try {
      search = await searchCJProducts(query, { page: 1, size: 3 });
    } catch {
      continue;
    }

    for (const candidate of search.products.map((x) => ({ ...x, variantId: null as string | null }))) {
      if (published >= limit) break;
      if (!candidate.imageUrl || !candidate.title) continue;

      try {
        const detail = await getCJProductDetail(candidate.id);
        if (!detail?.imageUrl || !detail.title) continue;

        const variants = await fetchCJProductVariants(candidate.id, { countryCode: "JP" });
        const variant =
          (candidate.variantId
            ? variants.find((x) => x.vid === candidate.variantId)
            : null) ?? selectUnambiguousVariant(variants);
        if (!variant?.vid) {
          rejected++;
          continue;
        }

        const stock = await fetchCJVariantStock(variant.vid);
        if (stock === null || stock <= 0) {
          rejected++;
          continue;
        }

        const freight = await calculateCJFreight(variant.vid, {
          startCountryCode: "CN",
          endCountryCode: "JP",
          quantity: 1,
        });
        if (freight === null || freight <= 0) {
          rejected++;
          continue;
        }

        const cost = Number(variant.sellPrice ?? detail.price ?? candidate.price);
        if (!Number.isFinite(cost) || cost <= 0) {
          rejected++;
          continue;
        }

        const salePrice = yenPrice(cost, freight, fxRate);
        const sourceRef = `cj:${candidate.id}:${variant.vid}`;
        const identityKey = sourceRef;
        const tracerSku = `TRC-CJ-${candidate.id.slice(-10)}-${variant.vid.slice(-10)}`;
        const now = new Date().toISOString();

        const productInsert = await db
          .from("products")
          .upsert(
            {
              canonical_name: detail.title,
              identity_key: identityKey,
            },
            { onConflict: "identity_key" },
          )
          .select("id")
          .single();

        if (productInsert.error) throw new Error(productInsert.error.message);
        const productId = String(productInsert.data.id);

        const supplierInsert = await db
          .from("supplier_listings")
          .upsert(
            {
              supplier: "cj",
              external_id: variant.vid,
              sku: variant.sku,
              title: detail.title,
              product_id: productId,
              cost,
              shipping_cost: freight,
              currency: "USD",
              inventory: Math.floor(stock),
              ship_to: "JP",
              order_method: "cj_api",
              api_available: true,
              identity_method: "supply_discovered",
              identity_status: "supply_discovered",
              identity_confidence: 1,
              configured: true,
              supplier_product_id: candidate.id,
              supplier_variant_id: variant.vid,
              cj_variant_id: variant.vid,
              orderable: true,
              price_confirmed: true,
              inventory_confirmed: true,
              tracking_available: false,
              fetched_at: now,
              metadata: {
                source: "cj_supply_first",
                source_ref: sourceRef,
                query,
                fx_rate: fxRate,
                freight_usd: freight,
                image_url: detail.imageUrl,
                variant_title: variant.nameEn,
              },
            },
            { onConflict: "supplier,external_id" },
          )
          .select("id")
          .single();

        if (supplierInsert.error) throw new Error(supplierInsert.error.message);
        const supplierListingId = String(supplierInsert.data.id);

        const listingSlug = slug(detail.title, candidate.id, variant.vid);
        const shopInsert = await db
          .from("shop_listings")
          .upsert(
            {
              product_id: productId,
              supplier_listing_id: supplierListingId,
              slug: listingSlug,
              title: detail.title,
              description: `TRACER supply-first product. Supplier: CJdropshipping. Variant: ${variant.nameEn ?? "standard"}.`,
              image_url: detail.imageUrl,
              selling_price: salePrice,
              currency: "JPY",
              supplier_name: "cj",
              supplier_product_id: candidate.id,
              supplier_variant_id: variant.vid,
              source_cost: cost,
              shipping_cost: freight,
              inventory: Math.floor(stock),
              orderable: true,
              tracking_available: false,
              identity_method: "supply_discovered",
              identity_confidence: 1,
              published: true,
              selection_reasons: [
                "supply_first",
                "live_cj_variant",
                "live_inventory_gt_zero",
                "live_japan_freight",
                `fx_usdjpy_${fxRate.toFixed(4)}`,
              ],
              missing: [],
              published_at: now,
              pipeline_stage: "PUBLISHED",
              pipeline_status: "published",
              pipeline_reason: "supply_first_gate_passed",
              pipeline_updated_at: now,
              updated_at: now,
            },
            { onConflict: "slug" },
          )
          .select("id")
          .single();

        if (shopInsert.error) throw new Error(shopInsert.error.message);

        discovered++;
        published++;
        items.push({
          listingId: String(shopInsert.data.id),
          productId,
          supplierListingId,
          title: detail.title,
          supplierProductId: candidate.id,
          supplierVariantId: variant.vid,
          costUsd: cost,
          freightUsd: freight,
          inventory: Math.floor(stock),
          sellingPriceJpy: salePrice,
          fxRate,
        });
      } catch (error) {
        rejected++;
        console.warn("[supply-first] candidate rejected", {
          productId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { discovered, published, rejected, items };
}
