import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { identifiersFromRecord, matchProductIdentity } from "@/lib/market/identifiers";

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function syncTracerCatalogFromInternalSupply(args: {
  bestsellerId: string;
  salePrice?: number | null;
}): Promise<{ matched: boolean; catalogId: string | null; variantId: string | null; reason?: string }> {
  const db = createSupabaseAdminClient();

  const { data: bestseller, error: bestsellerError } = await db
    .from("marketplace_bestsellers")
    .select("*")
    .eq("id", args.bestsellerId)
    .maybeSingle();

  if (bestsellerError) throw new Error(bestsellerError.message);
  if (!bestseller) return { matched: false, catalogId: null, variantId: null, reason: "bestseller_not_found" };

  const marketIds = identifiersFromRecord(bestseller as Record<string, unknown>);
  const queries = [
    ["jan", marketIds.jan],
    ["gtin", marketIds.gtin],
    ["ean", marketIds.ean],
    ["upc", marketIds.upc],
    ["mpn", marketIds.mpn],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  if (!queries.length) return { matched: false, catalogId: null, variantId: null, reason: "no_identifier" };

  const or = queries.map(([column, value]) => `${column}.eq.${value.replace(/[,()]/g, "")}`).join(",");

  const { data: products, error: productError } = await db
    .from("internal_supply_products")
    .select("*")
    .eq("active", true)
    .or(or)
    .limit(20);

  if (productError) throw new Error(productError.message);

  for (const product of products ?? []) {
    const productIds = identifiersFromRecord(product as Record<string, unknown>);
    const identity = matchProductIdentity({
      market: {
        ...marketIds,
        brand: str(bestseller.brand),
        title: String(bestseller.title ?? ""),
      },
      supply: {
        ...productIds,
        brand: str(product.brand),
        title: String(product.title ?? ""),
      },
    });

    if (!identity.salesEligible) continue;

    const { data: variants, error: variantError } = await db
      .from("internal_supply_variants")
      .select("*")
      .eq("supply_product_id", product.id)
      .eq("active", true)
      .eq("orderable", true)
      .gt("inventory", 0)
      .limit(100);

    if (variantError) throw new Error(variantError.message);

    const confirmed = (variants ?? []).map((variant) => {
      const ids = identifiersFromRecord(variant as Record<string, unknown>);
      return {
        variant,
        identity: matchProductIdentity({
          market: {
            ...marketIds,
            brand: str(bestseller.brand),
            title: String(bestseller.title ?? ""),
          },
          supply: {
            ...ids,
            brand: str(product.brand),
            title: String(variant.title ?? product.title ?? ""),
          },
        }),
      };
    }).filter((x) => x.identity.salesEligible);

    const selected = confirmed.length === 1
      ? confirmed[0]
      : confirmed.find((x) =>
          Boolean(
            (marketIds.jan && x.variant.jan === marketIds.jan) ||
            (marketIds.gtin && x.variant.gtin === marketIds.gtin) ||
            (marketIds.ean && x.variant.ean === marketIds.ean) ||
            (marketIds.upc && x.variant.upc === marketIds.upc),
          ),
        );

    if (!selected) continue;

    const variant = selected.variant;
    const inventory = num(variant.inventory) ?? num(product.inventory) ?? 0;
    const cost = num(variant.cost) ?? num(product.cost);
    const shipping = num(variant.shipping_cost) ?? num(product.shipping_cost) ?? 0;
    const salePrice = num(args.salePrice);
    const tracking = variant.tracking_available === true || product.tracking_available === true;
    const orderable = inventory > 0 && cost !== null && salePrice !== null && salePrice > cost + shipping && tracking;

    const { data: existing } = await db
      .from("tracer_supply_catalog")
      .select("id,sale_price,tracer_sku")
      .eq("bestseller_id", bestseller.id)
      .maybeSingle();

    const tracerSku = existing?.tracer_sku ??
      `TRC-${String(bestseller.id).replace(/-/g, "").slice(0, 16).toUpperCase()}`;

    const payload = {
      tracer_sku: tracerSku,
      title: String(bestseller.title ?? product.title),
      brand: str(bestseller.brand) ?? str(product.brand),
      category: str(bestseller.category),
      description: str(bestseller.description),
      image_url: str(bestseller.image_url),
      status: orderable ? "ready" : "draft",
      cost,
      shipping_cost: shipping,
      handling_cost: 0,
      sale_price: salePrice ?? num(existing?.sale_price),
      currency: str(variant.currency) ?? str(product.currency) ?? "JPY",
      inventory,
      lead_time_days: num(product.lead_time_days),
      tracking_available: tracking,
      orderable,
      source_type: "internal",
      source_ref: str(product.source_ref) ?? String(product.id),
      evidence: {
        identity_method: selected.identity.method,
        identity_confidence: selected.identity.confidence,
        identity_rationale: selected.identity.rationale,
        source: "internal_supply_products",
        supply_product_id: String(product.id),
        supply_variant_id: String(variant.id),
      },
      metadata: {
        source_name: product.source_name,
        fetched_at: product.fetched_at,
      },
      bestseller_id: bestseller.id,
      updated_at: new Date().toISOString(),
    };

    const { data: catalog, error: catalogError } = await db
      .from("tracer_supply_catalog")
      .upsert(payload, { onConflict: "tracer_sku" })
      .select("id")
      .single();

    if (catalogError) throw new Error(catalogError.message);

    const variantSku = str(variant.variant_sku) ?? `${tracerSku}-DEFAULT`;
    const { data: catalogVariant, error: catalogVariantError } = await db
      .from("tracer_supply_variants")
      .upsert({
        catalog_id: catalog.id,
        variant_sku: variantSku,
        title: str(variant.title) ?? str(product.title),
        barcode: str(variant.jan) ?? str(variant.gtin) ?? str(variant.ean) ?? str(variant.upc),
        attributes: variant.metadata ?? {},
        cost,
        inventory,
        orderable,
        updated_at: new Date().toISOString(),
      }, { onConflict: "variant_sku" })
      .select("id")
      .single();

    if (catalogVariantError) throw new Error(catalogVariantError.message);

    return {
      matched: true,
      catalogId: String(catalog.id),
      variantId: String(catalogVariant.id),
      reason: orderable ? "ready" : "matched_but_not_ready",
    };
  }

  return { matched: false, catalogId: null, variantId: null, reason: "no_sales_eligible_internal_supply" };
}
