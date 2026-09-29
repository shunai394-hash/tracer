import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getDropshipSupplierConfig } from "@/lib/config/env";
import { getOrosyProductDetail, getOrosyShippingQuote, searchOrosyProducts } from "@/lib/sources/orosy";
import { getCJConfig } from "@/lib/config/env";
import {
  CJConfigError,
  calculateCJFreight,
  fetchCJProductVariants,
  fetchCJVariantStock,
  getCJProductDetail,
  searchCJProducts,
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

    // ASIN is a valid marketplace identity anchor, but CJ does not expose
    // ASIN as a supplier search key. ASIN-only candidates therefore continue
    // into the bounded title/brand discovery path below; identity is still
    // accepted only after exact supplier evidence/variant-barcode matching.
    const hasMarketplaceIdentifier = Boolean(
      identifierQuery || marketIds.asin || supplierSearchQueries.length > 0,
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
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "SUPPLIER_INVESTIGATION",
        status: "blocked",
        reason: "cj_not_configured",
      });
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
      let directMatches: Awaited<ReturnType<typeof searchCJProducts>>["products"] = [];

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

      // CJ listV2 can return zero results for marketplace JAN/GTIN values
      // even when the catalog contains the product. Identifiers remain the
      // only acceptable identity evidence, but they are not always useful
      // as discovery keys. When identifier searches fail to prove identity,
      // add a bounded title/brand discovery pass. Discovery may find a
      // supplier candidate; it must still pass the exact variant-barcode
      // identity gate below before it can become sellable.
      if (directMatches.length === 0) {
        const title = String(record.title ?? "").trim();
        const brand = typeof record.brand === "string" ? record.brand.trim() : "";
        const asciiTokens = title
          .match(/[A-Za-z0-9][A-Za-z0-9+._-]{2,}/g)
          ?.map((token) => token.toLowerCase()) ?? [];
        const uniqueTokens = [...new Set(asciiTokens)].filter(
          (token) => !["with", "for", "and", "the", "new", "type", "size"].includes(token),
        );
        const discoveryQueries = [
          [brand, ...uniqueTokens.slice(0, 4)].filter(Boolean).join(" ").trim(),
          uniqueTokens.slice(0, 3).join(" ").trim(),
        ].filter(
          (query, index, values): query is string =>
            query.length >= 3 && values.indexOf(query) === index,
        ).slice(0, 2);

        for (const query of discoveryQueries) {
          cjQuery = query;
          try {
            const search = await searchCJProducts(query, { page: 1, size: 10 });
            searches.push(search);
          } catch (error) {
            console.warn("[investigate-dropship] CJ title discovery failed; continuing", {
              bestsellerId: String(record.id),
              query,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // If search did not prove identity at the product level, inspect a
      // relevance-ranked fallback set for variant-level barcode evidence.
      // Variant lookup is the expensive operation, so do not inspect all 10
      // results blindly. Relevance is used only to prioritize expensive
      // verification; it is never accepted as identity evidence.
      const searchProducts = searches.flatMap((search) => search.products);
      const marketTitle = String(record.title ?? "").toLowerCase();
      const marketTokens = marketTitle
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
      const marketMpn = marketIds.mpn?.toLowerCase() ?? null;
      const scoredProducts = searchProducts.map((product, index) => {
        const haystack = [product.title, product.sku]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const tokenOverlap = marketTokens.reduce(
          (score, token) => score + (haystack.includes(token) ? 1 : 0),
          0,
        );
        const mpnMatch = marketMpn && haystack.includes(marketMpn) ? 100 : 0;
        return { product, index, score: mpnMatch + tokenOverlap };
      });
      scoredProducts.sort((a, b) =>
        b.score - a.score || a.index - b.index,
      );
      const prioritizedProducts = directMatches.length > 0
        ? directMatches
        : scoredProducts.slice(0, 5).map((item) => item.product);
      const seenProductIds = new Set<string>();
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
          variants = await fetchCJProductVariants(detail.id, { countryCode: "CN" });
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

        // A product-level shipping field is often absent or stale. Once a
        // concrete, sales-eligible CJ variant is known, ask CJ's official
        // freight calculator for the current CN -> JP trial quote. Never
        // turn a failed quote into zero; the publication gate must continue
        // to treat shipping as unknown when CJ cannot quote it.
        let observedShippingCost = asNumber(detail.shippingCost);
        let verifiedInventory: number | null = null;
        let inventoryConfirmed = false;
        if (identity.salesEligible && selectedVariant) {
          try {
            verifiedInventory = await fetchCJVariantStock(selectedVariant.vid);
            inventoryConfirmed = verifiedInventory !== null;
          } catch (error) {
            console.warn("[investigate-dropship] CJ variant stock lookup failed; inventory remains unknown", {
              bestsellerId: String(record.id),
              cjProductId: detail.id,
              cjVariantId: selectedVariant.vid,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (identity.salesEligible && selectedVariant) {
          try {
            const freight = await calculateCJFreight(selectedVariant.vid, {
              startCountryCode: "CN",
              endCountryCode: "JP",
              quantity: 1,
            });
            if (freight !== null) observedShippingCost = freight;
          } catch (error) {
            console.warn("[investigate-dropship] CJ freight calculation failed; preserving existing shipping value", {
              bestsellerId: String(record.id),
              cjProductId: detail.id,
              cjVariantId: selectedVariant.vid,
              sourceCountryCode: "CN",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // A discovered CJ product is not a supplier offer until identity is
        // proven. Never persist a title-only/semantic candidate as a
        // supplier_listing: doing so attaches unrelated CJ inventory to a
        // marketplace bestseller and can contaminate downstream sales tests.
        if (!identity.salesEligible) {
          noIdentifierOverlap += 1;
          if (!supplyBarcode) supplyBarcodeMissing += 1;
          await markPipelineState({
            bestsellerId: String(record.id),
            stage: "SUPPLIER_INVESTIGATION",
            status: "blocked",
            reason: "identity_not_confirmed",
          });
          await writeEvidence({
            productId: typeof record.product_id === "string" ? record.product_id : null,
            bestsellerId: String(record.id),
            source: "cj",
            fetchedAt,
            fieldName: "identity_status",
            fieldValue: identity.method,
            evidenceClass: "unknown",
            confidence: identity.confidence,
            metadata: {
              rationale: identity.rationale,
              discovered_supplier_product_id: detail.id,
              supplier_barcode: supplyBarcode,
            },
          });
          continue;
        }

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
            // Use the exact confirmed variant price when one was selected.
            // Falling back to the parent product price is only safe when the
            // supplier exposes no variant-specific price.
            cost: asNumber(selectedVariant?.sellPrice ?? detail.price),
            shipping_cost: observedShippingCost,
            currency: "USD",
            supplier_product_id: detail.id,
            supplier_variant_id: cjVariantId,
            inventory: verifiedInventory,
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
            orderable: Boolean(cjVariantId) && inventoryConfirmed && (verifiedInventory ?? 0) > 0,
            price_confirmed: Boolean(selectedVariant?.sellPrice ?? detail.price),
            inventory_confirmed: inventoryConfirmed,
            fetched_at: fetchedAt,
            metadata: {
              search_query: identifierQuery ?? (marketIds.asin ? `asin:${marketIds.asin}` : null),
              rationale: identity.rationale,
              source_country_code: "CN",
              freight_quote: observedShippingCost,
            },
          })
          .select("id")
          .single();

        if (insert.error) throw new Error(insert.error.message);

        const pipelineReason = !identity.salesEligible
          ? "identity_not_confirmed"
          : !cjVariantId
            ? "supplier_variant_unknown"
            : !inventoryConfirmed
              ? "inventory_unverified"
              : (verifiedInventory ?? 0) <= 0
                ? "inventory_zero"
                : "supplier_variant_verified";
        await markPipelineState({
          bestsellerId: String(record.id),
          stage:
            identity.salesEligible && cjVariantId && inventoryConfirmed && (verifiedInventory ?? 0) > 0
              ? "VARIANT_VERIFIED"
              : "SUPPLIER_INVESTIGATION",
          status:
            identity.salesEligible && cjVariantId && inventoryConfirmed && (verifiedInventory ?? 0) > 0
              ? "ready"
              : "blocked",
          reason: pipelineReason,
        });

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
      await markPipelineState({
        bestsellerId: String(record.id),
        stage: "SUPPLIER_INVESTIGATION",
        status: "failed",
        reason: "supplier_investigation_failed",
        error: rowErrorDetail.error,
      });
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
    }

    // If CJ could not establish a linked supplier, try the configured
    // Orosy catalog using the same verified marketplace identifiers. Orosy
    // is discovery-only here until its stateful order flow is verified.
    try {
      const alternative = await investigateOrosyFallback({
        record,
        marketIds,
        fetchedAt,
        supabase,
      });
      if (alternative.found) matched += 1;
    } catch (error) {
      console.warn("[investigate-dropship] alternative supplier fallback failed", {
        bestsellerId: String(record.id),
        error: error instanceof Error ? error.message : String(error),
      });
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


