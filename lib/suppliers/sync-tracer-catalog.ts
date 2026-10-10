import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { exactBarcodeFamilyMatch, identifiersFromRecord } from "@/lib/market/identifiers";
import { hasExactCurrentRequestVariantSet, onlyCurrentRequestVariants } from "@/lib/suppliers/cj-identity-reverify-policy";

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function syncTracerCatalogFromInternalSupply(args: {
  bestsellerId: string;
  salePrice?: number | null;
  /** Exact internal_supply_variants row IDs written by this ingestion request. */
  variantIds?: string[];
}): Promise<{ matched: boolean; catalogId: string | null; variantId: string | null; reason?: string }> {
  const db = createSupabaseAdminClient();
  const suppliedVariantIds = (args.variantIds ?? []).filter((id) => typeof id === "string" && id.trim());
  const variantIds = [...new Set(suppliedVariantIds)];
  if (variantIds.length === 0) {
    return { matched: false, catalogId: null, variantId: null, reason: "no_variants_written_by_request" };
  }
  if (variantIds.length !== suppliedVariantIds.length) {
    return { matched: false, catalogId: null, variantId: null, reason: "duplicate_variant_ids_in_request_scope" };
  }

  const { data: bestseller, error: bestsellerError } = await db
    .from("marketplace_bestsellers")
    .select("*")
    .eq("id", args.bestsellerId)
    .maybeSingle();

  if (bestsellerError) throw new Error(bestsellerError.message);
  if (!bestseller) return { matched: false, catalogId: null, variantId: null, reason: "bestseller_not_found" };

  const marketIds = identifiersFromRecord(bestseller as Record<string, unknown>);
  if (![marketIds.jan, marketIds.gtin, marketIds.ean, marketIds.upc].some(Boolean)) {
    return { matched: false, catalogId: null, variantId: null, reason: "no_canonical_barcode_for_variant_proof" };
  }

  // Resolve the exact request-scoped variant set independently of product lookup.
  // Never use a product's other/older variants as fallback when IDs are missing or mismatched.
  const { data: requestedVariants, error: requestedVariantError } = await db
    .from("internal_supply_variants")
    .select("*")
    .in("id", variantIds);
  if (requestedVariantError) throw new Error(requestedVariantError.message);
  const scopedRows = (requestedVariants ?? []) as Array<Record<string, unknown> & { id: string; supply_product_id: string }>;
  if (!hasExactCurrentRequestVariantSet(scopedRows, variantIds)) {
    return { matched: false, catalogId: null, variantId: null, reason: "variant_scope_incomplete_or_cross_product" };
  }
  const requestedProductId = String(scopedRows[0].supply_product_id);
  if (scopedRows.some((variant) => variant.active !== true || variant.orderable !== true || (num(variant.inventory) ?? 0) <= 0)) {
    return { matched: false, catalogId: null, variantId: null, reason: "requested_variant_not_active_orderable_or_in_stock" };
  }

  // The exact request-scoped variant IDs establish supplier ownership. Do not require a
  // duplicate barcode on the parent product: some feeds expose it only on the concrete
  // variant. Parent title/MPN/ASIN is not proof of a concrete size/color/pack variant.
  const { data: product, error: productError } = await db
    .from("internal_supply_products")
    .select("*")
    .eq("id", requestedProductId)
    .eq("active", true)
    .maybeSingle();
  if (productError) throw new Error(productError.message);
  if (!product) return { matched: false, catalogId: null, variantId: null, reason: "owning_internal_supply_product_missing_or_inactive" };

  {


    const currentRequestVariants = onlyCurrentRequestVariants(
      scopedRows.filter((variant) => String(variant.supply_product_id) === requestedProductId) as Array<{ id: string; [key: string]: unknown }>,
      variantIds,
    );
    // Keep all current-request variants in the denominator. Filtering to sales-eligible
    // variants first makes exactIdentifierMatches.length equal confirmed.length, which
    // accidentally selects the first row when multiple variants share a product-level MPN.
    // Count identity proof per variant, then fail closed unless exactly one variant is proven.
    const variantCandidates = currentRequestVariants.map((variant) => {
      const ids = identifiersFromRecord(variant as Record<string, unknown>);
      const barcodeMethod = exactBarcodeFamilyMatch(marketIds, ids);
      return {
        variant,
        // Variant identity is proven only by an exact barcode-family match.
        // Product-level ASIN/MPN, title, and image similarity cannot select a variant.
        identity: {
          linked: barcodeMethod !== null,
          salesEligible: barcodeMethod !== null,
          method: barcodeMethod ?? "none",
          confidence: barcodeMethod ? 0.98 : 0,
          rationale: barcodeMethod ? "exact canonical-to-supplier variant barcode match" : "no_exact_variant_barcode_match",
        },
      };
    });

    const exactVariantCandidates = variantCandidates.filter(
      (candidate) => candidate.identity.linked && candidate.identity.salesEligible,
    );
    // A single candidate is not automatically a match: require exactly one barcode-proven variant.
    const selected = exactVariantCandidates.length === 1 ? exactVariantCandidates[0] : undefined;
    if (!selected) {
      return {
        matched: false,
        catalogId: null,
        variantId: null,
        reason: exactVariantCandidates.length > 1
          ? "multiple_exact_variant_barcode_matches"
          : "no_exact_variant_barcode_match",
      };
    }

    const variant = selected.variant;
    const { data: existing, error: existingError } = await db
      .from("tracer_supply_catalog")
      .select("id,sale_price,tracer_sku")
      .eq("bestseller_id", bestseller.id)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    const inventory = num(variant.inventory) ?? num(product.inventory) ?? 0;
    const cost = num(variant.cost) ?? num(product.cost);
    const shipping = num(variant.shipping_cost) ?? num(product.shipping_cost);
    // Preserve a previously validated catalog price when this invocation does not
    // submit a new one, but still recompute margin against fresh supplier economics.
    const salePrice = num(args.salePrice) ?? num(existing?.sale_price);
    const tracking = variant.tracking_available === true || product.tracking_available === true;
    const orderable = inventory > 0 && cost !== null && shipping !== null
      && salePrice !== null && salePrice > cost + shipping && tracking;

    const tracerSku = existing?.tracer_sku ??
      `TRC-${String(bestseller.id).replace(/-/g, "").slice(0, 16).toUpperCase()}`;

    const payload = {
      tracer_sku: tracerSku,
      title: String(bestseller.title ?? product.title),
      brand: str(bestseller.brand) ?? str(product.brand),
      category: str(bestseller.category),
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

    const variantSku = str(variant.variant_sku) ?? `${tracerSku}-DEFAULT`;
    const catalogPayload = {
      ...payload,
      // A non-orderable candidate can be cataloged as draft, but never elevated
      // by this RPC unless the locked source rows still match their generations.
    };
    const catalogVariantPayload = {
      catalog_id: null,
      variant_sku: variantSku,
      title: str(variant.title) ?? str(product.title),
      barcode: str(variant.jan) ?? str(variant.gtin) ?? str(variant.ean) ?? str(variant.upc),
      attributes: variant.metadata ?? {},
      cost,
      inventory,
      orderable,
      internal_supply_product_id: product.id,
      internal_supply_variant_id: variant.id,
      updated_at: new Date().toISOString(),
    };

    const productGeneration = num(product.generation);
    const variantGeneration = num(variant.generation);
    if (productGeneration === null || variantGeneration === null) {
      return { matched: false, catalogId: null, variantId: null, reason: "generation_missing" };
    }

    const { data: committed, error: commitError } = await db.rpc("commit_internal_supply_catalog_sync", {
      p_product_id: String(product.id),
      p_variant_id: String(variant.id),
      p_expected_product_generation: productGeneration,
      p_expected_variant_generation: variantGeneration,
      p_catalog: catalogPayload,
      p_catalog_variant: catalogVariantPayload,
    });
    if (commitError) throw new Error(commitError.message);

    const result = committed as {
      ok?: boolean;
      reason?: string;
      catalog_id?: string;
      catalog_variant_id?: string;
    } | null;
    if (!result?.ok || !result.catalog_id || !result.catalog_variant_id) {
      return {
        matched: false,
        catalogId: null,
        variantId: null,
        reason: result?.reason ?? "atomic_catalog_sync_rejected",
      };
    }

    return {
      matched: true,
      catalogId: String(result.catalog_id),
      variantId: String(result.catalog_variant_id),
      reason: orderable ? "ready" : "matched_but_not_ready",
    };
  }

  return { matched: false, catalogId: null, variantId: null, reason: "no_sales_eligible_internal_supply" };
}
