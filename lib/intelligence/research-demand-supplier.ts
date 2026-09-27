import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { searchSupplierProducts } from "@/lib/procurement/supplier-search";
import { generateSupplierProductQueries } from "@/lib/intelligence/generate-supplier-product-queries";

export async function researchDemandCandidateWithSupplier(
  candidateId: string,
): Promise<{
  candidateId: string;
  queries: string[];
  saved: number;
}> {
  const supabase = createSupabaseAdminClient();

  const { data: candidate, error: candidateError } = await supabase
    .from("demand_product_candidates")
    .select("id, query, category")
    .eq("id", candidateId)
    .single();

  if (candidateError || !candidate) {
    throw new Error(
      `Demand product candidate not found: ${
        candidateError?.message ?? candidateId
      }`,
    );
  }

  const queries = await generateSupplierProductQueries(
    candidate.query,
    candidate.category,
  );

  let saved = 0;

  for (const query of queries) {
    const result = await searchSupplierProducts(query);

    for (const product of result) {
      const { error } = await supabase
        .from("demand_supplier_products")
        .upsert(
          {
            demand_product_candidate_id: candidate.id,
            supplier_name: product.supplierName,
            supplier_product_id: product.supplierProductId,
            title: product.title,
            sku: null,
            identifier: product.identifier,
            price: product.unitCost,
            currency: product.currency,
            image_url: null,
            source_url: product.sourceUrl,
            inventory: null,
            available: product.available,
            orderable: product.orderable,
            tracking_available: product.trackingAvailable,
            supplier_query: query,
            total_records: result.length,
            total_pages: 1,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict:
              "demand_product_candidate_id,supplier_name,supplier_product_id",
          },
        );

      if (error) {
        throw new Error(
          `Failed to save supplier product: ${error.message}`,
        );
      }

      saved += 1;
    }
  }

  const { error: statusError } = await supabase
    .from("demand_product_candidates")
    .update({
      status: saved > 0 ? "product_found" : "researching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidate.id);

  if (statusError) {
    throw new Error(
      `Failed to update demand candidate status: ${statusError.message}`,
    );
  }

  return {
    candidateId: candidate.id,
    queries,
    saved,
  };
}
