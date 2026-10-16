import "server-only";

import {
  BrightDataConfigError,
  fetchBrightDataPage,
  isBrightDataFetchConfigured,
} from "@/lib/sources/brightdata/client";
import {
  parseAmazonBestsellersHtml,
  parseAmazonProductDetail,
  parseRakutenRankingHtml,
  parseYahooProductDetail,
  parseYahooRankingHtml,
  type ParsedBestseller,
} from "@/lib/market/parse-rankings";
import { extractAsinFromUrl, normalizeIdentifier } from "@/lib/market/identifiers";
import { inspectCanonicalMarketplaceVariantMarkup, parseAmazonVariationAsinMap, parseCanonicalMarketplaceVariantEvidence } from "@/lib/market/canonical-variant-evidence";
import { decodeHtmlBytes } from "@/lib/market/charset";
import { isAmazonChallengeHtml } from "@/lib/market/amazon-response";

export const MARKETPLACE_SOURCES = [
  // Yahoo! Shopping is demand research only. It must never be treated as a supplier.
  // Supplier discovery and orderability are handled by the supplier-native CJ pipeline.
  { marketplace: "yahoo_shopping", url: "https://shopping.yahoo.co.jp/ranking/", source: "yahoo_shopping_ranking" },
] as const;

/**
 * How many collected items per marketplace get a detail-page fetch for
 * identifier enrichment. Fetches run in parallel (Promise.all), so this is
 * a fan-out safety bound, not a latency budget — raising it does not
 * multiply wall-clock time the way the old sequential loop did.
 */
const DETAIL_ENRICHMENT_LIMIT = 10;
const YAHOO_DETAIL_ENRICHMENT_LIMIT = 4;

export type CollectedMarketplace = {
  marketplace: string;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  items: ParsedBestseller[];
  skipped?: boolean;
  reason?: string;
  /**
   * Where identifier enrichment actually landed for this marketplace this
   * run — without this, "0 identifiers found" cannot be distinguished from
   * "detail pages never returned HTML at all" (network/blocking) vs.
   * "HTML came back but had no JAN/JSON-LD" (real absence).
   */
  enrichment?: {
    attempted: number;
    htmlFetched: number;
    identifierFound: number;
    /** Explicit ProductGroup.hasVariant child rows extracted from fetched detail HTML. */
    canonicalVariantCount: number;
    jsonLdNodeCount: number;
    productGroupCount: number;
    productModelCount: number;
    groupsWithVariantCount: number;
    variantProductNodeCount: number;
    isVariantOfProductCount: number;
    inProductGroupWithIdCount: number;
    childProductsWithExplicitParentRelation: number;
    absoluteTypeIriCount: number;
    jsonLdScriptTagCount: number;
    jsonLdParseFailureCount: number;
    variationMapMarkerCount: number;
    dimensionToAsinMapMarkerCount: number;
    twisterDataMarkerCount: number;
    /** Aggregate-only child-variant recovery counters; never log child identifiers or raw HTML. */
    variationAsinsFound: number;
    childDetailAttempted: number;
    childDetailFetched: number;
    childBarcodeFound: number;
    /** Whether the configured proxy provider can retry Amazon anti-bot/challenge responses. */
    brightDataConfigured: boolean;
  };
};

async function fetchHtml(url: string, options: { retryBrightDataWhenCanonicalVariantsMissing?: boolean; retryBrightDataWhenAmazonIdentifierMissing?: boolean } = {}): Promise<string | null> {
  const directFetch = async (): Promise<string | null> => {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) return null;

      const bytes = new Uint8Array(await response.arrayBuffer());
      const html = decodeHtmlBytes(
        bytes,
        response.headers.get("content-type"),
      );

      return html.includes("<") ? html : null;
    } catch {
      return null;
    }
  };

  // Product detail pages: direct first, Bright Data fallback. A non-empty HTML
  // response is not sufficient evidence that a page was actually delivered:
  // marketplace anti-bot/challenge pages are also HTML and used to suppress the
  // fallback, leaving canonical-variant parsing at zero while the fetch looked
  // successful. For Amazon child-variant extraction, retry through Bright Data
  // when the direct response has no JSON-LD Product/ProductGroup markup.
  const directHtml = await directFetch();
  // Amazon can expose its child variants either as Schema.org ProductGroup
  // nodes or as an explicit dimensionValuesDisplayData child-ASIN map. Treat
  // both as usable variant evidence when deciding whether Bright Data improved
  // a direct response; otherwise a useful child-ASIN map gets discarded.
  const hasAmazonVariantEvidence = (html: string | null): boolean =>
    Boolean(
      html &&
      (
        parseCanonicalMarketplaceVariantEvidence(html, url).length > 0 ||
        parseAmazonVariationAsinMap(html, url).length > 0
      )
    );
  // Child detail pages need a stronger success condition than "some HTML":
  // challenge pages often return HTTP 200 HTML but contain no concrete barcode.
  // Only use that direct response immediately when the requested evidence exists.
  const hasAmazonProductIdentifier = (html: string | null): boolean => {
    if (!html) return false;
    const detail = parseAmazonProductDetail(html);
    return Boolean(
      normalizeIdentifier("jan", detail.jan) ||
      normalizeIdentifier("gtin", detail.gtin) ||
      normalizeIdentifier("ean", detail.ean) ||
      normalizeIdentifier("upc", detail.upc)
    );
  };
  const directIsChallenge = isAmazonChallengeHtml(directHtml, url);
  const directHasRequiredEvidence =
    !directIsChallenge &&
    (!options.retryBrightDataWhenCanonicalVariantsMissing || hasAmazonVariantEvidence(directHtml)) &&
    (!options.retryBrightDataWhenAmazonIdentifierMissing || hasAmazonProductIdentifier(directHtml));
  if (directHtml && directHasRequiredEvidence) return directHtml;

  if (isBrightDataFetchConfigured()) {
    try {
      const page = await fetchBrightDataPage(url);
      const brightDataHasRequiredEvidence =
        !isAmazonChallengeHtml(page.html, url) &&
        (!options.retryBrightDataWhenCanonicalVariantsMissing || hasAmazonVariantEvidence(page.html)) &&
        (!options.retryBrightDataWhenAmazonIdentifierMissing || hasAmazonProductIdentifier(page.html));
      if (page.html && brightDataHasRequiredEvidence) {
        return page.html;
      }
      // If Bright Data did not improve the response, retain a usable direct
      // response for ordinary parsing/diagnostics. It still cannot create
      // canonical evidence unless the strict JSON-LD parser finds child nodes.
      if (directHtml && !directIsChallenge) return directHtml;
      if (page.html && !isAmazonChallengeHtml(page.html, url)) return page.html;
    } catch {
      // Fall through to the direct response if one exists.
    }
  }

  return directIsChallenge ? null : directHtml;
}
function enrichAmazon(item: ParsedBestseller): ParsedBestseller {
  return {
    ...item,
    asin: item.asin ?? extractAsinFromUrl(item.productUrl),
  };
}

export async function collectMarketplaceBestsellers(options: { sourceIndex?: number } = {}): Promise<{
  fetchedAt: string;
  marketplaces: CollectedMarketplace[];
  itemCount: number;
  sourceIndex: number;
}> {
  const fetchedAt = new Date().toISOString();
  const marketplaces: CollectedMarketplace[] = [];
  const requestedSourceIndex = Math.max(0, options.sourceIndex ?? 0);
  const hasExplicitSourceIndex = options.sourceIndex !== undefined;
  const sourceEntries = hasExplicitSourceIndex
    ? Array.from({ length: Math.min(3, MARKETPLACE_SOURCES.length) }, (_, offset) => {
        const index = (requestedSourceIndex + offset) % MARKETPLACE_SOURCES.length;
        return { sourceIndex: index, source: MARKETPLACE_SOURCES[index] };
      })
    : MARKETPLACE_SOURCES.map((source, sourceIndex) => ({ sourceIndex, source }));
  if (sourceEntries.length === 0) {
    return { fetchedAt, marketplaces: [], itemCount: 0, sourceIndex: requestedSourceIndex };
  }

  // Probe up to three sources per patrol in priority order. A blocked or
  // layout-drifted ranking page must not burn an entire 15-minute cycle while
  // a later source (e.g. Rakuten) may still return usable products. Fetch the
  // bounded probe set concurrently, then select the first source with parsed
  // items so the persisted cursor resumes at the source that actually worked.
  const collectedSources = await Promise.all(
    sourceEntries.map(async ({ source, sourceIndex }) => {
      try {
        const html = await fetchHtml(source.url);
        return { source, sourceIndex, html, error: null as unknown };
      } catch (error) {
        return { source, sourceIndex, html: null, error };
      }
    }),
  );

  let effectiveSourceIndex = requestedSourceIndex;
  for (const { source, sourceIndex: currentSourceIndex, html, error: sourceError } of collectedSources) {
    effectiveSourceIndex = currentSourceIndex;
    try {
      if (sourceError) throw sourceError;
      if (!html) {
        marketplaces.push({
          marketplace: source.marketplace,
          source: source.source,
          sourceUrl: source.url,
          fetchedAt,
          items: [],
          skipped: true,
          reason: isBrightDataFetchConfigured()
            ? "page_html_not_returned"
            : "brightdata_not_configured_and_direct_fetch_empty",
        });
        continue;
      }

      // The active observation source list is deliberately Yahoo-only.
      // Keep this parser selection aligned with that compile-time source set.
      const items: ParsedBestseller[] = parseYahooRankingHtml(html);

      // Ranking/listing pages never carry a barcode themselves (Amazon,
      // Rakuten and Yahoo all omit JAN from the grid view), so identity
      // enrichment always requires a follow-up fetch of each item's own
      // product page. Amazon and Yahoo!ショッピング both expose JAN on
      // their detail pages; Rakuten does not reliably expose one and is
      // left as-is rather than guessed at.
      //
      // Every collected item is enriched (not just the first few) —
      // whichever items happen to carry a real identifier must not depend
      // on where they landed in the ranking — fetched in parallel so
      // covering more items does not multiply wall-clock time; capped at
      // DETAIL_ENRICHMENT_LIMIT as a deliberate bound against an unbounded
      // fetch fan-out if a source ever returns an unusually large page.
      marketplaces.push({
        marketplace: source.marketplace,
        source: source.source,
        sourceUrl: source.url,
        fetchedAt,
        items,
        // A successful HTTP response that parses into zero ranking items is
        // not a successful observation; expose likely challenge/layout drift.
        skipped: items.length === 0,
        reason: items.length === 0 ? "ranking_html_returned_zero_items" : undefined,
      });
      if (items.length > 0 && hasExplicitSourceIndex) break;
    } catch (error) {
      if (error instanceof BrightDataConfigError) {
        marketplaces.push({
          marketplace: source.marketplace,
          source: source.source,
          sourceUrl: source.url,
          fetchedAt,
          items: [],
          skipped: true,
          reason: "brightdata_not_configured",
        });
        continue;
      }
      throw error;
    }
  }

async function enrichMarketplaceDetails(marketplace: CollectedMarketplace): Promise<CollectedMarketplace> {
  if (marketplace.items.length === 0) return marketplace;

  const limit = marketplace.marketplace === "yahoo_shopping" || marketplace.marketplace === "rakuten"
    ? YAHOO_DETAIL_ENRICHMENT_LIMIT
    : marketplace.marketplace === "amazon.co.jp"
      ? DETAIL_ENRICHMENT_LIMIT
      : 0;

  if (limit === 0) return marketplace;

  const details = marketplace.items.slice(0, limit);
  let htmlFetched = 0;
  let identifierFound = 0;
  let canonicalVariantCount = 0;
  let jsonLdNodeCount = 0;
  let productGroupCount = 0;
  let productModelCount = 0;
  let groupsWithVariantCount = 0;
  let variantProductNodeCount = 0;
  let isVariantOfProductCount = 0;
  let inProductGroupWithIdCount = 0;
  let childProductsWithExplicitParentRelation = 0;
  let absoluteTypeIriCount = 0;
  let jsonLdScriptTagCount = 0;
  let jsonLdParseFailureCount = 0;
  let variationMapMarkerCount = 0;
  let dimensionToAsinMapMarkerCount = 0;
  let twisterDataMarkerCount = 0;
  let variationAsinsFound = 0;
  let childDetailAttempted = 0;
  let childDetailFetched = 0;
  let childBarcodeFound = 0;

  await Promise.all(details.map(async (item) => {
    if (!item.productUrl) return;
    try {
      const detailHtml = await fetchHtml(item.productUrl, { retryBrightDataWhenCanonicalVariantsMissing: marketplace.marketplace === "amazon.co.jp" });
      if (!detailHtml) return;
      htmlFetched += 1;

      // Canonical child evidence is marketplace-neutral Schema.org data. The
      // old branch parsed ProductGroup children only for Amazon, so Yahoo
      // Shopping pages with the same explicit child GTIN/JAN were discarded.
      const markup = inspectCanonicalMarketplaceVariantMarkup(detailHtml);
      jsonLdNodeCount += markup.jsonLdNodeCount;
      productGroupCount += markup.productGroupCount;
      productModelCount += markup.productModelCount;
      groupsWithVariantCount += markup.groupsWithVariantCount;
      variantProductNodeCount += markup.variantProductNodeCount;
      isVariantOfProductCount += markup.isVariantOfProductCount;
      inProductGroupWithIdCount += markup.inProductGroupWithIdCount;
      childProductsWithExplicitParentRelation += markup.childProductsWithExplicitParentRelation;
      absoluteTypeIriCount += markup.absoluteTypeIriCount;
      jsonLdScriptTagCount += markup.jsonLdScriptTagCount;
      jsonLdParseFailureCount += markup.jsonLdParseFailureCount;
      variationMapMarkerCount += markup.variationMapMarkerCount;
      dimensionToAsinMapMarkerCount += markup.dimensionToAsinMapMarkerCount;
      twisterDataMarkerCount += markup.twisterDataMarkerCount;
      item.canonicalVariants = parseCanonicalMarketplaceVariantEvidence(detailHtml, item.productUrl);

      if (marketplace.marketplace === "amazon.co.jp") {
        const detail = parseAmazonProductDetail(detailHtml);
        // ProductGroup.hasVariant and Amazon's explicit child-ASIN map are
        // independent evidence channels. Fetch any child page whose exact ASIN
        // does not yet have a concrete barcode, including JSON-LD children that
        // exist structurally but lack JAN/GTIN/EAN/UPC.
        const childAsins = parseAmazonVariationAsinMap(detailHtml, item.productUrl).slice(0, 6);
        const knownBarcodeAsins = new Set(
          item.canonicalVariants
            .filter((variant) => Boolean(variant.jan || variant.gtin || variant.ean || variant.upc))
            .map((variant) => variant.asin)
            .filter((value): value is string => Boolean(value)),
        );
        const childAsinsToFetch = childAsins.filter((child) => !knownBarcodeAsins.has(child.asin));
        variationAsinsFound += childAsins.length;
        childDetailAttempted += childAsinsToFetch.length;
        const recovered = await Promise.all(childAsinsToFetch.map(async (child) => {
          const childUrl = `https://www.amazon.co.jp/dp/${child.asin}`;
          const childHtml = await fetchHtml(childUrl, { retryBrightDataWhenAmazonIdentifierMissing: true });
          if (childHtml) childDetailFetched += 1;
          const childDetail = childHtml ? parseAmazonProductDetail(childHtml) : null;
          const jan = normalizeIdentifier("jan", childDetail?.jan ?? null);
          const gtin = normalizeIdentifier("gtin", childDetail?.gtin ?? null);
          const ean = normalizeIdentifier("ean", childDetail?.ean ?? null);
          const upc = normalizeIdentifier("upc", childDetail?.upc ?? null);
          const hasBarcode = Boolean(jan || gtin || ean || upc);
          if (hasBarcode) childBarcodeFound += 1;
          const childModel = normalizeIdentifier("mpn", childDetail?.model ?? null);
          const parentModel = normalizeIdentifier("mpn", item.model);
          // Save explicit child-ASIN/dimension evidence even if the child page
          // is unavailable or exposes no barcode. Such rows are discovery-only;
          // they cannot pass supplier identity or sales eligibility on ASIN alone.
          return {
            sourceVariantId: child.asin,
            sku: null,
            title: child.variationValues.length ? child.variationValues.join(" / ") : null,
            asin: child.asin,
            jan,
            gtin,
            ean,
            upc,
            mpn: childModel && childModel !== parentModel ? childModel : null,
            productUrl: childUrl,
            evidenceSource: "amazon_variation_asin_map" as const,
            rawEvidence: {
              source_variant_id: child.asin,
              parent_product_url: item.productUrl,
              child_product_url: childUrl,
              variation_values: child.variationValues,
              child_jan: jan,
              child_gtin: gtin,
              child_ean: ean,
              child_upc: upc,
              child_detail_fetched: Boolean(childHtml),
              child_detail_has_barcode: hasBarcode,
              extraction: !childHtml ? "variation_map_only_child_fetch_failed" : hasBarcode ? "child_detail_page" : "child_detail_page_barcode_missing",
            },
          };
        }));
        const recoveredBySourceId = new Map(
          recovered
            .filter((value): value is NonNullable<typeof value> => value !== null)
            .map((value) => [value.sourceVariantId, value] as const),
        );
        const recoveredSourceIds = new Set<string>();
        // Preserve the original JSON-LD provenance when enriching an existing
        // child row; attach child-page evidence without copying parent fields.
        item.canonicalVariants = item.canonicalVariants.map((variant) => {
          const child = recoveredBySourceId.get(variant.sourceVariantId);
          if (!child) return variant;
          recoveredSourceIds.add(child.sourceVariantId);
          return {
            ...variant,
            jan: variant.jan ?? child.jan,
            gtin: variant.gtin ?? child.gtin,
            ean: variant.ean ?? child.ean,
            upc: variant.upc ?? child.upc,
            mpn: variant.mpn ?? child.mpn,
            productUrl: variant.productUrl ?? child.productUrl,
            rawEvidence: { ...variant.rawEvidence, child_detail_page: child.rawEvidence },
          };
        });
        const existingSourceIds = new Set(item.canonicalVariants.map((variant) => variant.sourceVariantId));
        item.canonicalVariants.push(
          ...[...recoveredBySourceId.values()].filter((variant) =>
            !existingSourceIds.has(variant.sourceVariantId) && !recoveredSourceIds.has(variant.sourceVariantId)
          ),
        );
        canonicalVariantCount += item.canonicalVariants.length;
        item.brand = detail.brand;
        item.model = detail.model;
        item.jan = normalizeIdentifier("jan", detail.jan);
        item.mpn = normalizeIdentifier("mpn", detail.model);
        if (item.price === null && detail.price !== null) {
          item.price = detail.price;
          item.currency = detail.currency ?? "JPY";
        }
        if (item.jan || item.mpn) identifierFound += 1;
      } else {
        canonicalVariantCount += item.canonicalVariants.length;
        if (marketplace.marketplace === "yahoo_shopping") {
          const detail = parseYahooProductDetail(detailHtml);
          item.jan = normalizeIdentifier("jan", detail.jan);
          item.gtin = normalizeIdentifier("gtin", detail.gtin);
          item.mpn = normalizeIdentifier("mpn", detail.mpn);
          item.brand = detail.brand;
          if (item.price === null && detail.price !== null) {
            item.price = detail.price;
            item.currency = detail.currency ?? "JPY";
          }
          if (item.jan || item.gtin || item.mpn) identifierFound += 1;
        }
      }
    } catch {
      // Detail pages stay unknown rather than blocking the listing.
    }
  }));

  return {
    ...marketplace,
    enrichment: {
      attempted: details.length,
      htmlFetched,
      identifierFound,
      canonicalVariantCount,
      jsonLdNodeCount,
      productGroupCount,
      productModelCount,
      groupsWithVariantCount,
      variantProductNodeCount,
      isVariantOfProductCount,
      inProductGroupWithIdCount,
      childProductsWithExplicitParentRelation,
      absoluteTypeIriCount,
      jsonLdScriptTagCount,
      jsonLdParseFailureCount,
      variationMapMarkerCount,
      dimensionToAsinMapMarkerCount,
      twisterDataMarkerCount,
      variationAsinsFound,
      childDetailAttempted,
      childDetailFetched,
      childBarcodeFound,
      brightDataConfigured: isBrightDataFetchConfigured(),
    },
  };
}

  // Enrich detail pages concurrently across marketplace sources. The previous
  // implementation enriched each source inside the sequential parse loop,
  // so six Amazon categories could consume six separate network waits inside
  // the same 60-second function. Keep a small per-source cap and fan them out.
  const enrichedMarketplaces = await Promise.all(
    marketplaces.map((marketplace) => enrichMarketplaceDetails(marketplace)),
  );

  return {
    fetchedAt,
    marketplaces: enrichedMarketplaces,
    itemCount: enrichedMarketplaces.reduce((sum, item) => sum + item.items.length, 0),
    sourceIndex: effectiveSourceIndex,
  };
}



