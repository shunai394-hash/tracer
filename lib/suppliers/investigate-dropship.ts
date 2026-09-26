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

export async function investigateDropshipForBestsellers(
  bestsellerIds: string[],
): Promise<{
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
  const supplierConfig = getDropshipSupplierConfig();

  const { data: rows, error } = bestsellerIds.length === 0
    ? { data: [], error: null }
    : await supabase
        .from("marketplace_bestsellers")
        .select("*")
        .in("id", bestsellerIds);

  if (error) throw new Error(error.message);

  let processed = 0;
  let matched = 0;
  let skippedNoIdentifier = 0;
  let unconfigured = 0;
  let noIdentifierOverlap = 0;
  let supplyBarcodeMissing = 0;
  let rowErrors = 0;
  const rowErrorDetails: Array<{
    bestsellerId: string;
    title: string;
    stage: string;
    query: string | null;
    cjProductId: string | null;
    error: string;
  }> = [];

  for (const row of rows ?? []) {
    processed += 1;
    const record = row as Record<string, unknown>;
    // Shared with every other identity-derivation call site in the app
    // (see lib/market/identifiers.ts): this also recovers ASIN from
    // `product_url` when the column itself is empty, instead of only
    // reading the `asin` column the way the old local helper did.
    const marketIds = identifiersFromRecord(record);
    // CJ product search does not return marketplace ASINs. ASIN is valid
    // marketplace identity evidence, but not a CJ supplier-search key.
    const supplierSearchQueries = [
      marketIds.jan,
      marketIds.gtin,
      marketIds.ean,
      marketIds.upc,
      marketIds.mpn,
    ].filter(
      (value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index,
    );
    const identifierQuery = pickIdentifierQuery({
      ...marketIds,
      asin: null,
    });

    if (!identifierQuery || supplierSearchQueries.length === 0) {
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
      const identifierQueries = supplierSearchQueries;

      // CJ is rate-limited, so searching every identifier for every row and
      // then inspecting 20 products creates a large serial request fan-out.
      // Search identifiers in verified-priority order and stop immediately
      // when CJ itself returns a product carrying an exact marketplace
      // identifier. This preserves the strict identity gate while avoiding
      // needless requests after identity is already proven.
      const searches: Awaited<ReturnType<typeof searchCJProducts>>[] = [];
      let directMatches: Awaited<ReturnType<typeof searchCJProducts>>[number]["products"] = [];

      for (const query of identifierQueries) {
        cjQuery = query;
        try {
          const search = await searchCJProducts(query, { page: 1, size: 10 });
          searches.push(search);

          const direct = search.products.filter((product) => {
            if (!product.barcode) return false;
            const supplyIds = identifiersFromRecord({
              asin: null,
              jan: null,
              gtin: product.barcode,
              ean: null,
              upc: null,
              mpn: null,
            });
            const identity = matchProductIdentity({
              market: {
                ...marketIds,
                brand: typeof record.brand === "string" ? record.brand : null,
                title: String(record.title ?? ""),
                imageUrl: typeof record.image_url === "string" ? record.image_url : null,
              },
              supply: { ...supplyIds, title: product.title, imageUrl: product.imageUrl },
            });
            return identity.salesEligible;
          });

          if (direct.length > 0) {
            directMatches = direct;
            break;
          }
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

      // If search did not prove identity at the product level, inspect only a
      // small fallback set for variant-level barcode evidence. Variant lookup
      // is the expensive operation; inspecting 20 unrelated search results
      // multiplied the CJ request volume without relaxing the identity gate.
      const searchProducts = searches.flatMap((search) => search.products);
      const seenProductIds = new Set<string>();
      const prioritizedProducts = directMatches.length > 0
        ? directMatches
        : searchProducts.slice(0, 3);
      for (const product of prioritizedProducts) {
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

        // CJ's own SKU is CJ's internal catalog id, not a marketplace
        // identifier. The official CJ API documents the VARIANT barcode as a
        // numeric identifier, so identity must be checked against variant
        // barcodes before a supplier listing can become sales-eligible.
        //
        // This was the critical gap in the previous pipeline: we fetched
        // /product/variant/query but only used it to choose a variant AFTER
        // identity matching. Consequently a CJ product could contain the
        // exact barcode needed to prove identity while the product-level
        // payload appeared barcode-less, producing identity_not_confirmed.
        let variants: Awaited<ReturnType<typeof fetchCJProductVariants>> = [];
        cjStage = "variants";
        try {
          variants = await fetchCJProductVariants(detail.id);
        } catch {
          // Variant lookup failure leaves identity unconfirmed rather than
          // inventing an identifier.
        }

        const variantIdentityMatches = variants
          .map((variant) => {
            const barcode = variant.barcode;
            if (!barcode) return null;

            const supplyIds = identifiersFromRecord({
              asin: null,
              jan: null,
              gtin: barcode,
              ean: null,
              upc: null,
              mpn: null,
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

            return { variant, supplyIds, identity };
          })
          .filter(
            (
              item,
            ): item is {
              variant: (typeof variants)[number];
              supplyIds: ReturnType<typeof identifiersFromRecord>;
              identity: ReturnType<typeof matchProductIdentity>;
            } => item !== null,
          );

        // An exact marketplace/CJ barcode match identifies the variant even
        // when the parent CJ product contains several variants. If there is
        // no exact barcode match, retain the old strict identity rules.
        const confirmedVariantMatches = variantIdentityMatches.filter(
          (item) => item.identity.salesEligible,
        );
        const confirmedVariant =
          confirmedVariantMatches.length === 1
            ? confirmedVariantMatches[0]
            : null;

        const fallbackSupplyIds = identifiersFromRecord({
          asin: null,
          jan: null,
          gtin: detail.barcode ?? product.barcode,
          ean: null,
          upc: null,
          mpn: null,
        });

        const identity = confirmedVariant
          ? confirmedVariant.identity
          : matchProductIdentity({
              market: {
                ...marketIds,
                brand: typeof record.brand === "string" ? record.brand : null,
                title: String(record.title ?? ""),
                imageUrl: typeof record.image_url === "string" ? record.image_url : null,
              },
              supply: {
                ...fallbackSupplyIds,
                title: detail.title,
                imageUrl: detail.imageUrl,
              },
            });

        const selectedVariant =
          confirmedVariant?.variant ??
          (variants.length === 1 ? variants[0] : null);

        const supplyIds = confirmedVariant?.supplyIds ?? fallbackSupplyIds;
        const supplyBarcode =
          confirmedVariant?.variant.barcode ??
          detail.barcode ??
          product.barcode ??
          null;

        // Only an exactly matched barcode may select one variant from a
        // multi-variant product. Otherwise a single-variant product may still
        // be used if identity was already confirmed at product level.
        const cjVariantId = identity.salesEligible && selectedVariant
          ? selectedVariant.vid
          : null;
        const variantSku = identity.salesEligible && selectedVariant
          ? selectedVariant.sku
          : null;

        cjStage = "supplier_listing_insert";
        const insert = await supabase
          .from("supplier_listings")
          .insert({
            supplier: "CJdropshipping",
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
        if (!supplyBarcode) supplyBarcodeMissing += 1;

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
      const rowErrorDetail = {
        bestsellerId: String(record.id),
        title: String(record.title ?? ""),
        stage: cjStage,
        query: cjQuery,
        cjProductId,
        error: error instanceof Error ? error.message : String(error),
      };
      rowErrorDetails.push(rowErrorDetail);
      console.error("[investigate-dropship] row failed, continuing batch", rowErrorDetail);
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
    rowErrorDetails: rowErrorDetails.slice(0, 20),
  };
}
