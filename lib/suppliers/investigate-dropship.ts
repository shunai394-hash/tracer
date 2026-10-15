import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBrightDataPage } from "@/lib/sources/brightdata/client";
import { parseAmazonProductDetail } from "@/lib/market/parse-rankings";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import {
  identifiersFromRecord,
  pickIdentifierQuery,
} from "@/lib/market/identifiers";
import { linkInternalSupplyForBestseller } from "@/lib/suppliers/internal-catalog";

async function enrichAsinOnlyRows(rows: Record<string, unknown>[]): Promise<void> {
  const targets = rows.filter((record) => {
    const ids = identifiersFromRecord(record);
    return Boolean(ids.asin) && !ids.jan && !ids.gtin && !ids.ean && !ids.upc && !ids.mpn;
  });

  await Promise.all(targets.map(async (record) => {
    const asin = identifiersFromRecord(record).asin;
    if (!asin) return;
    try {
      const url = typeof record.product_url === "string" && record.product_url
        ? record.product_url
        : `https://www.amazon.co.jp/dp/${asin}`;
      const page = await fetchBrightDataPage(url);
      if (!page.html) return;
      const detail = parseAmazonProductDetail(page.html);
      const jan = normalizeIdentifier("jan", detail.jan);
      const gtin = normalizeIdentifier("gtin", detail.gtin);
      const ean = normalizeIdentifier("ean", detail.ean);
      const upc = normalizeIdentifier("upc", detail.upc);
      const mpn = normalizeIdentifier("mpn", detail.model);
      const brand = detail.brand?.trim() || null;
      if (!jan && !gtin && !ean && !upc && !mpn && !brand) return;

      const update = {
        jan,
        gtin,
        ean,
        upc,
        mpn,
        brand,
        model: detail.model ?? null,
        pipeline_updated_at: new Date().toISOString(),
      };
      const supabase = createSupabaseAdminClient();
      const { error } = await supabase
        .from("marketplace_bestsellers")
        .update(update)
        .eq("id", String(record.id));
      if (error) throw new Error(error.message);

      Object.assign(record, update);
    } catch (error) {
      console.warn("[investigate-dropship] ASIN detail enrichment failed", {
        bestsellerId: String(record.id),
        asin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}


async function markPipelineState(args: {
  bestsellerId: string;
  stage: string;
  status: string;
  reason: string | null;
  error?: string | null;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("marketplace_bestsellers")
    .update({
      pipeline_stage: args.stage,
      pipeline_status: args.status,
      pipeline_reason: args.reason,
      pipeline_error: args.error ?? null,
      pipeline_updated_at: new Date().toISOString(),
    })
    .eq("id", args.bestsellerId);
  if (error) throw new Error(error.message);
}


export async function investigateDropshipForBestsellers(
  bestsellerIds: string[],
): Promise<{
  processed: number;
  matched: number;
  skippedNoIdentifier: number;
  unconfigured: number;
  noIdentifierOverlap: number;
  supplyBarcodeMissing: number;
  rowErrors: number;
  rowErrorDetails: Array<{
    bestsellerId: string;
    title: string;
    stage: string;
    query: string | null;
    cjProductId: string | null;
    error: string;
  }>;
}> {
  const supabase = createSupabaseAdminClient();
  const fetchedAt = new Date().toISOString();
  const { data: rows, error } = bestsellerIds.length === 0
    ? { data: [], error: null }
    : await supabase.from("marketplace_bestsellers").select("*").in("id", bestsellerIds);
  if (error) throw new Error(error.message);
  await enrichAsinOnlyRows((rows ?? []) as Record<string, unknown>[]);

  let processed = 0;
  let matched = 0;
  let skippedNoIdentifier = 0;
  const unconfigured = 0;
  let noIdentifierOverlap = 0;
  const rowErrors = 0;
  const rowErrorDetails: Array<{ bestsellerId: string; title: string; stage: string; query: string | null; cjProductId: string | null; error: string }> = [];

  for (const row of rows ?? []) {
    processed += 1;
    const record = row as Record<string, unknown>;
    const marketIds = identifiersFromRecord(record);

    const internalSupply = await linkInternalSupplyForBestseller({ bestseller: record, fetchedAt });
    if (internalSupply.matched) {
      matched += 1;
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "VARIANT_VERIFIED",
        status: "ready",
        reason: "tracer_internal_supply_verified",
      });
      continue;
    }

    const hasMarketplaceIdentifier = Boolean(
      pickIdentifierQuery({ ...marketIds, asin: null }) || marketIds.asin,
    );
    if (!hasMarketplaceIdentifier) {
      skippedNoIdentifier += 1;
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "SUPPLIER_INVESTIGATION",
        status: "blocked",
        reason: "supplier_search_identifier_missing",
      });
      await writeEvidence({
        productId: typeof record.product_id === "string" ? record.product_id : null,
        bestsellerId: String(record.id),
        source: "dropship_investigation",
        fetchedAt,
        fieldName: "identity",
        fieldValue: null,
        evidenceClass: "unknown",
        confidence: 0,
        metadata: { note: "no_identifier_title_search_forbidden" },
      });
      continue;
    }

    noIdentifierOverlap += 1;
    await markPipelineState({
      bestsellerId: String(record.id),
      stage: "SUPPLIER_INVESTIGATION",
      status: "blocked",
      reason: "supplier_identity_unlinked",
    });
  }

  return {
    processed,
    matched,
    skippedNoIdentifier,
    unconfigured,
    noIdentifierOverlap,
    supplyBarcodeMissing: 0,
    rowErrors,
    rowErrorDetails: rowErrorDetails.slice(0, 20),
  };
}

