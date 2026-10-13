import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Projects one exact, recently fetched CJ supplier variant into TRACER's
 * canonical catalog without requiring marketplace/bestseller evidence.
 *
 * This function only creates/refreshes a draft. It never enables ordering or
 * publication; the database RPC repeats ownership, freshness and generation
 * checks under row locks.
 */
export async function stageCjSupplierFirstDraft(args: {
  productId: string;
  variantId: string;
}): Promise<{ staged: boolean; reason: string; catalogId?: string; catalogVariantId?: string }> {
  const db = createSupabaseAdminClient();
  const { data: product, error: productError } = await db
    .from("internal_supply_products")
    .select("id,generation,source_name,active,source_ref,metadata")
    .eq("id", args.productId)
    .maybeSingle();
  if (productError) throw new Error("cj_supplier_first_product_read_failed: " + productError.message);
  if (!product) return { staged: false, reason: "product_missing" };

  const { data: variant, error: variantError } = await db
    .from("internal_supply_variants")
    .select("id,generation,supply_product_id,source_name,active,variant_id,metadata")
    .eq("id", args.variantId)
    .maybeSingle();
  if (variantError) throw new Error("cj_supplier_first_variant_read_failed: " + variantError.message);
  if (!variant) return { staged: false, reason: "variant_missing" };
  if (String(variant.supply_product_id) !== String(product.id)) {
    return { staged: false, reason: "variant_product_scope_mismatch" };
  }
  if (product.source_name !== "cj" || variant.source_name !== "cj") {
    return { staged: false, reason: "not_cj_source" };
  }
  if (product.active !== true || variant.active !== true) {
    return { staged: false, reason: "source_inactive" };
  }
  if (!Number.isInteger(Number(product.generation)) || !Number.isInteger(Number(variant.generation))) {
    return { staged: false, reason: "generation_missing" };
  }

  const { data, error } = await db.rpc("stage_cj_supplier_first_catalog_draft", {
    p_product_id: String(product.id),
    p_variant_id: String(variant.id),
    p_expected_product_generation: Number(product.generation),
    p_expected_variant_generation: Number(variant.generation),
  });
  if (error) throw new Error("cj_supplier_first_catalog_stage_failed: " + error.message);

  const result = data as { ok?: boolean; reason?: string; catalog_id?: string; catalog_variant_id?: string } | null;
  if (!result?.ok || !result.catalog_id || !result.catalog_variant_id) {
    return { staged: false, reason: result?.reason ?? "catalog_stage_rejected" };
  }
  return {
    staged: true,
    reason: "draft_non_orderable",
    catalogId: String(result.catalog_id),
    catalogVariantId: String(result.catalog_variant_id),
  };
}
