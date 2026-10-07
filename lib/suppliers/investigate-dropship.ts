import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getDropshipSupplierConfig } from "@/lib/config/env";
import { getOrosyProductDetail, getOrosyShippingQuote, searchOrosyProducts } from "@/lib/sources/orosy";
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

async function investigateOrosyFallback(args: {
  record: Record<string, unknown>;
  marketIds: ReturnType<typeof identifiersFromRecord>;
  fetchedAt: string;
  supabase: ReturnType<typeof createSupabaseAdminClient>;
}): Promise<{ found: boolean; listingId: string | null }> {
  const { record, marketIds, fetchedAt, supabase } = args;
  const config = getDropshipSupplierConfig();
  if (!config.orosy) return { found: false, listingId: null };

  const { data: existing } = await supabase
    .from("supplier_listings")
    .select("id")
    .eq("bestseller_id", record.id)
    .eq("identity_status", "linked")
    .limit(1);

  if ((existing ?? []).length > 0) return { found: false, listingId: null };

  const queries = [
    marketIds.jan,
    marketIds.gtin,
    marketIds.ean,
    marketIds.upc,
    marketIds.mpn,
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index,
  ).slice(0, 3);

  for (const query of queries) {
    try {
      const products = await searchOrosyProducts(query);
      for (const product of products.slice(0, 5)) {
        const detail = await getOrosyProductDetail(product.id);
        if (!detail) continue;

        const marketTitle = String(record.title ?? "");
        const marketBrand = typeof record.brand === "string" ? record.brand : null;
        const variationMatches = detail.variations
          .map((variation) => {
            const supplyIds = identifiersFromRecord({
              asin: null,
              jan: variation.jan,
              gtin: variation.jan,
              ean: variation.jan,
              upc: variation.jan,
              mpn: detail.productNumber,
            });
            const identity = matchProductIdentity({
              market: {
                ...marketIds,
                brand: marketBrand,
                title: marketTitle,
                imageUrl: typeof record.image_url === "string" ? record.image_url : null,
              },
              supply: {
                ...supplyIds,
                title: detail.title,
                imageUrl: detail.imageUrl,
              },
            });
            return { variation, supplyIds, identity };
          })
          .filter((item) => item.identity.salesEligible);

        const confirmed = variationMatches.length === 1 ? variationMatches[0] : null;
        if (!confirmed) continue;

        const shipping = await getOrosyShippingQuote(detail.id);
        const inventory = confirmed.variation.stockQty;
        const orderable =
          confirmed.variation.stockQty !== null &&
          confirmed.variation.stockQty > 0 &&
          detail.orderable === true;

        const insert = await supabase
          .from("supplier_listings")
          .insert({
            supplier: "orosy",
            external_id: detail.id,
            sku: null,
            title: detail.title,
            bestseller_id: record.id,
            product_id: record.product_id,
            asin: confirmed.supplyIds.asin,
            jan: confirmed.supplyIds.jan,
            gtin: confirmed.supplyIds.gtin,
            ean: confirmed.supplyIds.ean,
            upc: confirmed.supplyIds.upc,
            mpn: confirmed.supplyIds.mpn,
            cost: confirmed.variation.buyerPrice,
            shipping_cost: shipping.unresolved ? null : shipping.amount,
            currency: confirmed.variation.currency ?? "JPY",
            supplier_product_id: detail.id,
            supplier_variant_id: confirmed.variation.variationId,
            inventory,
            tracking_available: null,
            order_method: "orosy_api",
            api_available: true,
            identity_method: confirmed.identity.method,
            identity_status: "linked",
            identity_confidence: confirmed.identity.confidence,
            configured: true,
            orderable,
            price_confirmed: confirmed.variation.buyerPrice !== null,
            inventory_confirmed: inventory !== null,
            fetched_at: fetchedAt,
            metadata: {
              search_query: query,
              rationale: confirmed.identity.rationale,
              source: "orosy_fallback",
              shipping_status: shipping.status,
            },
          })
          .select("id")
          .single();

        if (insert.error) throw new Error(insert.error.message);

        await writeEvidence({
          productId: typeof record.product_id === "string" ? record.product_id : null,
          bestsellerId: String(record.id),
          supplierListingId: insert.data.id,
          source: "orosy",
          fetchedAt,
          fieldName: "identity_status",
          fieldValue: "linked",
          evidenceClass: "actual",
          confidence: confirmed.identity.confidence,
          metadata: { rationale: confirmed.identity.rationale },
        });

        await markPipelineState({
          bestsellerId: String(record.id),
          stage: "ALTERNATIVE_SUPPLIER_FOUND",
          status: "ready",
          reason: "orosy_identity_verified",
        });

        return { found: true, listingId: String(insert.data.id) };
      }
    } catch (error) {
      console.warn("[investigate-dropship] Orosy fallback failed; continuing", {
        bestsellerId: String(record.id),
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { found: false, listingId: null };
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

    try {
      const alternative = await investigateOrosyFallback({
        record,
        marketIds,
        fetchedAt,
        supabase,
      });
      if (alternative.found) {
        matched += 1;
        continue;
      }

      const config = getDropshipSupplierConfig();
      if (!config.orosy) {
        await recordUnconfiguredSupplier({
          supplier: "orosy",
          bestsellerId: String(record.id),
          fetchedAt,
        });
        unconfigured += 1;
      }
      noIdentifierOverlap += 1;
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "SUPPLIER_INVESTIGATION",
        status: "blocked",
        reason: config.orosy ? "non_cj_supplier_match_not_found" : "orosy_not_configured",
      });
    } catch (error) {
      rowErrors += 1;
      const detail = {
        bestsellerId: String(record.id),
        title: String(record.title ?? ""),
        stage: "orosy_investigation",
        query: pickIdentifierQuery({ ...marketIds, asin: null }),
        cjProductId: null,
        error: error instanceof Error ? error.message : String(error),
      };
      rowErrorDetails.push(detail);
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "SUPPLIER_INVESTIGATION",
        status: "failed",
        reason: "supplier_investigation_failed",
        error: detail.error,
      });
      console.error("[investigate-dropship] non-CJ row failed, continuing batch", detail);
    }
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

