import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBrightDataPage } from "@/lib/sources/brightdata/client";
import { parseAmazonProductDetail } from "@/lib/market/parse-rankings";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import {
  identifiersFromRecord,
  matchProductIdentity,
  pickIdentifierQuery,
} from "@/lib/market/identifiers";
import { linkInternalSupplyForBestseller } from "@/lib/suppliers/internal-catalog";

const UNCONFIGURED_SUPPLIERS = [
  "hypersku",
  "dsers",
  "zendrop",
  "syncee",
] as const;

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

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

async function recordUnconfiguredSupplier(args: {
  supplier: string;
  bestsellerId: string;
  fetchedAt: string;
}) {
  const supabase = createSupabaseAdminClient();
  // One placeholder per (supplier, bestseller) is enough. Re-inserting it on
  // every investigation pass is what inflated supplier_listings to tens of
  // thousands of non-orderable rows.
  const { data: existing } = await supabase
    .from("supplier_listings")
    .select("id")
    .eq("supplier", args.supplier)
    .eq("bestseller_id", args.bestsellerId)
    .eq("configured", false)
    .limit(1);
  if ((existing ?? []).length > 0) return;
  await supabase.from("supplier_listings").insert({
    supplier: args.supplier,
    bestseller_id: args.bestsellerId,
    configured: false,
    api_available: false,
    identity_status: "unknown",
    metadata: { note: "api_not_configured" },
    fetched_at: args.fetchedAt,
  });
  await writeEvidence({
    bestsellerId: args.bestsellerId,
    source: args.supplier,
    fetchedAt: args.fetchedAt,
    fieldName: "api_available",
    fieldValue: null,
    evidenceClass: "unknown",
    confidence: 0,
    metadata: { note: "supplier_api_not_configured" },
  });
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
  let unconfigured = 0;
  let noIdentifierOverlap = 0;
  let rowErrors = 0;
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

    // ORO​​SY is intentionally out of scope. Do not create placeholder supplier rows
    // or block the CJ verification path because an unused supplier is unconfigured.
    noIdentifierOverlap += 1;
    await markPipelineState({
      bestsellerId: String(record.id),
      stage: "SUPPLIER_INVESTIGATION",
      status: "pending",
      reason: "cj_supplier_verification_pending",
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

