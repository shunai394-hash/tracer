import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getDropshipSupplierConfig } from "@/lib/config/env";
import { getCJConfig } from "@/lib/config/env";
import {
  CJConfigError,
  fetchCJProductVariants,
  getCJProductDetail,
  searchCJProducts,
  selectUnambiguousVariant,
} from "@/lib/sources/cj";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import {
  identifiersFromRecord,
  matchProductIdentity,
  pickIdentifierQuery,
} from "@/lib/market/identifiers";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

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

async function recordUnconfiguredSupplier(args: {
  supplier: string;
  bestsellerId: string;
  fetchedAt: string;
}) {
  const supabase = createSupabaseAdminClient();
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

export async function investigateDropshipForBestsellers(): Promise<{
  processed: number;
  matched: number;
  skippedNoIdentifier: number;
  unconfigured: number;
  /** CJ candidates searched but with zero identifier overlap (identity_method="none"). */
  noIdentifierOverlap: number;
  /** Of those searched, how many CJ product details had no barcode at all. */
  supplyBarcodeMissing: number;
  /** Rows where CJ search/detail/insert failed for this row only; other rows still processed. */
  rowErrors: number;
}> {
  const supabase = createSupabaseAdminClient();
  const fetchedAt = new Date().toISOString();
  const supplierConfig = getDropshipSupplierConfig();

  const { data: rows, error } = await supabase
    .from("marketplace_bestsellers")
    .select("*")
    .order("fetched_at", { ascending: false })
    .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

  if (error) throw new Error(error.message);

  let processed = 0;
  let matched = 0;
  let skippedNoIdentifier = 0;
  let unconfigured = 0;
  let noIdentifierOverlap = 0;
  let supplyBarcodeMissing = 0;
  let rowErrors = 0;

  for (const row of rows ?? []) {
    processed += 1;
    const record = row as Record<string, unknown>;
    // Shared with every other identity-derivation call site in the app
    // (see lib/market/identifiers.ts): this also recovers ASIN from
    // `product_url` when the column itself is empty, instead of only
    // reading the `asin` column the way the old local helper did.
    const marketIds = identifiersFromRecord(record);
    const identifierQuery = pickIdentifierQuery(marketIds);

    if (!identifierQuery) {
      skippedNoIdentifier += 1;
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

    for (const supplier of UNCONFIGURED_SUPPLIERS) {
      if (!supplierConfig[supplier]) {
        await recordUnconfiguredSupplier({
          supplier,
          bestsellerId: String(record.id),
          fetchedAt,
        });
        unconfigured += 1;
      }
    }

    if (!getCJConfig().apiKey) {
      await recordUnconfiguredSupplier({
        supplier: "cj",
        bestsellerId: String(record.id),
        fetchedAt,
      });
      unconfigured += 1;
      continue;
    }

    let cjStage = "search";
    let cjQuery: string | null = null;
    let cjProductId: string | null = null;
    try {
      // Try every verified marketplace identifier, not just the first one.
      // This matters for Amazon rows where ASIN is present but the supplier
      // catalog is searchable by the separately verified MPN/JAN.
      const identifierQueries = [
        marketIds.jan,
        marketIds.gtin,
        marketIds.ean,
        marketIds.upc,
        marketIds.mpn,
        marketIds.asin,
      ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

      let searches = [] as Awaited<ReturnType<typeof searchCJProducts>>[];
      for (const query of identifierQueries) {
        cjQuery = query;
        try {
          const search = await searchCJProducts(query, { page: 1, size: 10 });
          searches.push(search);
          if (search.products.some((product) => product.barcode && product.barcode.trim())) break;
        } catch (error) {
          // One identifier can be rejected or temporarily fail at CJ.
          // Continue with the next independently verified identifier instead
          // of discarding the entire bestseller row.
          console.error("[investigate-dropship] CJ search query failed, continuing", {
            bestsellerId: String(record.id),
            query,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const searchProducts = searches.flatMap((search) => search.products);
      const seenProductIds = new Set<string>();
      for (const product of searchProducts.slice(0, 10)) {
        if (seenProductIds.has(product.id)) continue;
        seenProductIds.add(product.id);
        cjProductId = product.id;
        cjStage = "detail";
        let detail = product;
        try {
          const queried = await getCJProductDetail(product.id);
          if (queried) detail = queried;
        } catch {
          // Detail unknown does not invent shipping/barcode.
        }

        // CJ's own SKU is CJ's internal catalog id, not an Amazon ASIN nor a
        // manufacturer part number — copying it into either field would be
        // fabricating an identifier CJ never claimed, so it is left out
        // entirely. CJ's barcode/productBarCode field also never states
        // which national retail-barcode standard it follows, so it is
        // recorded as a generic GTIN (the GS1 umbrella standard) instead of
        // being guessed to be specifically JAN/EAN/UPC and copied into all
        // four at once. matchProductIdentity() compares GTIN against the
        // marketplace side's JAN/EAN/UPC/GTIN as one barcode family (same
        // digits, GS1 zero-padding), so a real match is still detected
        // without asserting a national scheme CJ never disclosed.
        const supplyIds = identifiersFromRecord({
          asin: null,
          jan: null,
          gtin: detail.barcode,
          ean: null,
          upc: null,
          mpn: null,
          title: detail.title,
          url: null,
        });

        const identity = matchProductIdentity({
          market: {
            ...marketIds,
            brand: typeof record.brand === "string" ? record.brand : null,
            title: String(record.title ?? ""),
            imageUrl: typeof record.image_url === "string" ? record.image_url : null,
          },
          supply: {
            ...supplyIds,
            title: detail.title,
            imageUrl: detail.imageUrl,
          },
        });

        // Only auto-assign a variant when the product has exactly one — picking
        // among several would be a guess (which unknown-value rules here forbid).
        // See the UNVERIFIED FIELD MAPPING note on fetchCJProductVariants: the
        // endpoint/field names come from secondary sources, not a page this
        // code read directly (CJ's docs domain is blocked by network egress here).
        let cjVariantId: string | null = null;
        let variantSku: string | null = null;
        cjStage = "variants";
        try {
          const variants = await fetchCJProductVariants(detail.id);
          const unambiguous = selectUnambiguousVariant(variants);
          if (unambiguous) {
            cjVariantId = unambiguous.vid;
            variantSku = unambiguous.sku;
          }
        } catch {
          // Variant lookup failing does not block the listing; it just leaves
          // cj_variant_id unknown, which the order gate already treats as a hard stop.
        }

        cjStage = "supplier_listing_insert";
        const insert = await supabase
          .from("supplier_listings")
          .insert({
            supplier: "cj",
            external_id: detail.id,
            sku: variantSku ?? detail.sku,
            cj_variant_id: cjVariantId,
            title: detail.title,
            bestseller_id: record.id,
            product_id: record.product_id,
            asin: supplyIds.asin,
            jan: supplyIds.jan,
            gtin: supplyIds.gtin,
            ean: supplyIds.ean,
            upc: supplyIds.upc,
            mpn: supplyIds.mpn,
            cost: asNumber(detail.price),
            shipping_cost: asNumber(detail.shippingCost),
            currency: "USD",
            inventory: detail.inventory,
            tracking_available: true,
            order_method: "cj_api",
            api_available: true,
            identity_method: identity.method,
            identity_status: identity.salesEligible
              ? "linked"
              : identity.method === "none"
                ? "unconfirmed"
                : identity.method,
            identity_confidence: identity.confidence,
            configured: true,
            fetched_at: fetchedAt,
            metadata: {
              search_query: identifierQuery,
              rationale: identity.rationale,
            },
          })
          .select("id")
          .single();

        if (insert.error) throw new Error(insert.error.message);
        if (identity.salesEligible) matched += 1;
        if (identity.method === "none") noIdentifierOverlap += 1;
        if (!detail.barcode) supplyBarcodeMissing += 1;

        await writeEvidence({
          productId: typeof record.product_id === "string" ? record.product_id : null,
          bestsellerId: String(record.id),
          supplierListingId: insert.data.id,
          source: "cj",
          fetchedAt,
          fieldName: "identity_status",
          fieldValue: identity.salesEligible ? "linked" : identity.method,
          evidenceClass: identity.salesEligible ? "actual" : "unknown",
          confidence: identity.confidence,
          metadata: { rationale: identity.rationale },
        });
      }
    } catch (error) {
      if (error instanceof CJConfigError) {
        await recordUnconfiguredSupplier({
          supplier: "cj",
          bestsellerId: String(record.id),
          fetchedAt,
        });
        unconfigured += 1;
        continue;
      }
      // One product's CJ search/detail/insert failure must not stop the
      // rest of the batch. It is never silently dropped: logged to the
      // server console (a real DB integrity error is a bug worth seeing)
      // and counted in rowErrors so the API response reports it.
      rowErrors += 1;
      console.error("[investigate-dropship] row failed, continuing batch", {
        bestsellerId: String(record.id),
        title: String(record.title ?? ""),
        stage: cjStage,
        query: cjQuery,
        cjProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      await writeEvidence({
        productId: typeof record.product_id === "string" ? record.product_id : null,
        bestsellerId: String(record.id),
        source: "cj",
        fetchedAt,
        fieldName: "investigation_error",
        fieldValue: error instanceof Error ? error.message : String(error),
        evidenceClass: "unknown",
        confidence: 0,
        metadata: { note: "row_isolated_failure" },
      });
      continue;
    }
  }

  return {
    processed,
    matched,
    skippedNoIdentifier,
    unconfigured,
    noIdentifierOverlap,
    supplyBarcodeMissing,
    rowErrors,
  };
}
