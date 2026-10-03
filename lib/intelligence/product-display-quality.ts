import "server-only";

import { getFoundationStatus } from "@/lib/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ProductDisplayQuality = {
  status: "PASS" | "BLOCKED" | "DEGRADED";
  publishableNow: boolean;
  reasons: string[];
  foundation: {
    supabase: boolean;
    gemini: boolean;
    brightData: boolean;
    cj: boolean;
    ecPulse: boolean;
    newfindInbound: boolean;
    newfindOutbound: boolean;
    base: boolean;
  };
  counts: {
    demandObservations: number;
    demandMatches: number;
    demandCandidatesNew: number;
    demandCandidatesResolved: number;
    demandCJLinked: number;
    supplierLinked: number;
    supplierVerifiedOrderable: number;
    internalCatalogReady: number;
    internalVariantsOrderable: number;
    opportunityTestReady: number;
    salesTests: number;
    publishedListings: number;
    baseLinkedPublished: number;
  };
  gate: {
    demandEvidence: boolean;
    identityEvidence: boolean;
    supplyEvidence: boolean;
    economicsEvidence: boolean;
    testReadyEvidence: boolean;
    publishedEvidence: boolean;
  };
};

async function countRows(
  table: string,
  configure?: (query: ReturnType<ReturnType<typeof createSupabaseAdminClient>["from"]>) => ReturnType<ReturnType<typeof createSupabaseAdminClient>["from"]>,
): Promise<number> {
  const supabase = createSupabaseAdminClient();
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (configure) query = configure(query);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

export async function auditProductDisplayQuality(): Promise<ProductDisplayQuality> {
  const foundation = getFoundationStatus();

  const [
    demandObservations,
    demandMatches,
    demandCandidatesNew,
    demandCandidatesResolved,
    demandCJLinked,
    supplierLinked,
    supplierVerifiedOrderable,
    internalCatalogReady,
    internalVariantsOrderable,
    opportunityTestReady,
    salesTests,
    publishedListings,
    baseLinkedPublished,
  ] = await Promise.all([
    countRows("demand_observations"),
    countRows("demand_product_matches"),
    countRows("demand_product_candidates", (q) => q.eq("status", "new")),
    countRows("demand_product_candidates", (q) => q.in("status", ["product_found", "offer_found"])),
    countRows("demand_cj_products", (q) => q.eq("identity_status", "linked")),
    countRows("supplier_listings", (q) => q.eq("identity_status", "linked")),
    countRows("supplier_listings", (q) =>
      q.eq("identity_status", "linked")
        .eq("verification_status", "verified")
        .eq("inventory_confirmed", true)
        .eq("orderable", true),
    ),
    countRows("tracer_supply_catalog", (q) => q.eq("status", "ready").eq("orderable", true)),
    countRows("tracer_supply_variants", (q) => q.eq("orderable", true).gt("inventory", 0)),
    countRows("opportunity_intelligence", (q) => q.eq("sellability_state", "TEST_READY")),
    countRows("sales_tests"),
    countRows("shop_listings", (q) => q.eq("published", true)),
    countRows("shop_listings", (q) => q.eq("published", true).not("base_item_id", "is", null)),
  ]);

  const reasons: string[] = [];
  const supabaseReady = foundation.supabasePublic && foundation.supabaseServiceRole;
  const demandEvidence = demandObservations > 0 && (demandMatches > 0 || demandCandidatesResolved > 0);
  const identityEvidence = demandCJLinked > 0 || supplierLinked > 0 || internalCatalogReady > 0;
  const supplyEvidence = supplierVerifiedOrderable > 0 || internalVariantsOrderable > 0;
  const economicsEvidence = opportunityTestReady > 0;
  const testReadyEvidence = opportunityTestReady > 0 && salesTests > 0;
  const publishedEvidence = publishedListings > 0;

  if (!supabaseReady) reasons.push("supabase_not_ready");
  if (!foundation.gemini) reasons.push("gemini_not_configured");
  if (!foundation.brightData) reasons.push("brightdata_not_configured");
  if (!demandEvidence) reasons.push("demand_evidence_incomplete");
  if (!identityEvidence) reasons.push("identity_evidence_incomplete");
  if (!supplyEvidence) reasons.push("verified_supply_not_ready");
  if (!economicsEvidence) reasons.push("test_ready_economics_not_ready");
  if (!testReadyEvidence) reasons.push("sales_test_not_created");
  if (publishedListings === 0) reasons.push("no_published_product");
  if (publishedListings > 0 && baseLinkedPublished < publishedListings) {
    reasons.push("published_product_not_fully_linked_to_base");
  }

  const safeToDisplay = publishedListings === 0 || (testReadyEvidence && publishedListings > 0);
  const status: ProductDisplayQuality["status"] =
    !supabaseReady || !safeToDisplay
      ? "BLOCKED"
      : reasons.length > 0
        ? "DEGRADED"
        : "PASS";

  return {
    status,
    publishableNow: testReadyEvidence && supplyEvidence && economicsEvidence,
    reasons,
    foundation: {
      supabase: supabaseReady,
      gemini: foundation.gemini,
      brightData: foundation.brightData,
      cj: foundation.cj,
      ecPulse: foundation.ecPulse,
      newfindInbound: foundation.newfindInbound,
      newfindOutbound: foundation.newfindOutbound,
      base: foundation.base,
    },
    counts: {
      demandObservations,
      demandMatches,
      demandCandidatesNew,
      demandCandidatesResolved,
      demandCJLinked,
      supplierLinked,
      supplierVerifiedOrderable,
      internalCatalogReady,
      internalVariantsOrderable,
      opportunityTestReady,
      salesTests,
      publishedListings,
      baseLinkedPublished,
    },
    gate: {
      demandEvidence,
      identityEvidence,
      supplyEvidence,
      economicsEvidence,
      testReadyEvidence,
      publishedEvidence,
    },
  };
}
