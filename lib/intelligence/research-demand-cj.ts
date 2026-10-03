import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { searchCJProducts } from "@/lib/sources/cj";
import { generateCJProductQueries } from "@/lib/intelligence/generate-cj-product-queries";


export async function recordCandidateResolutionEvidence(args: {
  candidateId: string;
  fieldName: string;
  fieldValue: string;
  evidenceClass?: "actual" | "estimated" | "unknown";
  confidence?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: candidate } = await supabase
    .from("demand_product_candidates")
    .select("id")
    .eq("id", args.candidateId)
    .maybeSingle();

  const { error } = await supabase.from("evidence_ledger").insert({
    product_id: null,
    bestseller_id: null,
    supplier_listing_id: null,
    source: "demand_candidate_resolution",
    url: null,
    fetched_at: new Date().toISOString(),
    field_name: args.fieldName,
    field_value: args.fieldValue,
    evidence_class: args.evidenceClass ?? "actual",
    confidence: args.confidence ?? 1,
    metadata: {
      candidate_id: args.candidateId,
      candidate_exists: Boolean(candidate),
      ...(args.metadata ?? {}),
    },
  });
  if (error) {
    throw new Error(`Failed to persist candidate resolution evidence: ${error.message}`);
  }
}

export async function researchDemandCandidateWithCJ(
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

  const queries = await generateCJProductQueries(
    candidate.query,
    candidate.category,
  );

  let saved = 0;

  for (const query of queries) {
    const result = await searchCJProducts(query, {
      page: 1,
      size: 20,
    });


    await recordCandidateResolutionEvidence({
      candidateId: candidate.id,
      fieldName: "candidate_resolution_query",
      fieldValue: query,
      evidenceClass: "actual",
      confidence: 1,
      metadata: {
        stage: "cj_search",
        cj_total_records: result.totalRecords,
        cj_total_pages: result.totalPages,
        result_count: result.products.length,
      },
    });

    for (const product of result.products) {
      const { error } = await supabase
        .from("demand_cj_products")
        .upsert(
          {
            demand_product_candidate_id: candidate.id,
            cj_product_id: product.id,
            title: product.title,
            sku: product.sku,
            price: product.price ? Number(product.price) : null,
            image_url: product.imageUrl,
            inventory: product.inventory,
            listed_num: product.listedNum,
            product_type: product.productType,
            sale_status: product.saleStatus,
            cj_query: query,
            cj_total_records: result.totalRecords,
            cj_total_pages: result.totalPages,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "demand_product_candidate_id,cj_product_id",
          },
        );

      if (error) {
        throw new Error(`Failed to save CJ product: ${error.message}`);
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

  await recordCandidateResolutionEvidence({
    candidateId: candidate.id,
    fieldName: "candidate_resolution_result",
    fieldValue: saved > 0 ? "product_found" : "no_supplier_products_found",
    evidenceClass: "actual",
    confidence: 1,
    metadata: { queries, saved },
  });

  return {
    candidateId: candidate.id,
    queries,
    saved,
  };
}
