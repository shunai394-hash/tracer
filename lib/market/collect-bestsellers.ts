import "server-only";

import {
  BrightDataConfigError,
  fetchBrightDataPage,
  isBrightDataConfigured,
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

export const MARKETPLACE_SOURCES = [
  { marketplace: "yahoo_shopping", url: "https://shopping.yahoo.co.jp/ranking/", source: "yahoo_shopping_ranking" },
  { marketplace: "rakuten", url: "https://ranking.rakuten.co.jp/", source: "rakuten_ranking" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/beauty/", source: "amazon_bestsellers_beauty" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/", source: "amazon_bestsellers" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/electronics/", source: "amazon_bestsellers_electronics" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/kitchen/", source: "amazon_bestsellers_kitchen" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/home/", source: "amazon_bestsellers_home" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/sports/", source: "amazon_bestsellers_sports" },
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
    groupsWithVariantCount: number;
    variantProductNodeCount: number;
    absoluteTypeIriCount: number;
    /** Aggregate-only child-variant recovery counters; never log child identifiers or raw HTML. */
    variationAsinsFound: number;
    childDetailAttempted: number;
    childDetailFetched: number;
    childBarcodeFound: number;
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
  // Amazon can expose variants as Schema.org ProductGroup nodes or an explicit
  // child-ASIN map. Child pages need their own concrete barcode evidence.
  const hasAmazonVariantEvidence = (html: string | null): boolean =>
    Boolean(html && (
      parseCanonicalMarketplaceVariantEvidence(html, url).length > 0 ||
      parseAmazonVariationAsinMap(html, url).length > 0
    ));
  const hasAmazonBarcodeEvidence = (html: string | null): boolean => {
    if (!html) return false;
    const detail = parseAmazonProductDetail(html);
    return Boolean(detail.jan || detail.gtin || detail.ean || detail.upc);
  };
  const requiresEvidence = Boolean(
    options.retryBrightDataWhenCanonicalVariantsMissing ||
    options.retryBrightDataWhenAmazonIdentifierMissing
  );
  const hasRequiredEvidence = (html: string | null): boolean =>
    options.retryBrightDataWhenAmazonIdentifierMissing
      ? hasAmazonBarcodeEvidence(html)
      : hasAmazonVariantEvidence(html);

  if (directHtml && (!requiresEvidence || hasRequiredEvidence(directHtml))) {
    return directHtml;
  }

  if (isBrightDataConfigured()) {
    try {
      const page = await fetchBrightDataPage(url);
      if (page.html && (!requiresEvidence || hasRequiredEvidence(page.html))) {
        return page.html;
      }
      // Keep a direct page for diagnostics, but never accept a child barcode
      // unless the parser extracts it from that child's own detail page.
      if (directHtml) return directHtml;
      if (page.html) return page.html;
    } catch {
      // Fall through to the direct response if one exists.
    }
  }

  return directHtml;
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
          reason: isBrightDataConfigured()
            ? "page_html_not_returned"
            : "brightdata_not_configured_and_direct_fetch_empty",
        });
        continue;
      }

      const items: ParsedBestseller[] =
        source.marketplace === "amazon.co.jp"
          ? parseAmazonBestsellersHtml(html).map(enrichAmazon)
          : source.marketplace === "rakuten"
            ? parseRakutenRankingHtml(html)
            : parseYahooRankingHtml(html);

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

  const limit = marketplace.marketplace === "yahoo_shopping"
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
  let groupsWithVariantCount = 0;
  let variantProductNodeCount = 0;
  let absoluteTypeIriCount = 0;
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

      if (marketplace.marketplace === "amazon.co.jp") {
        const detail = parseAmazonProductDetail(detailHtml);
        const markup = inspectCanonicalMarketplaceVariantMarkup(detailHtml);
        jsonLdNodeCount += markup.jsonLdNodeCount;
        productGroupCount += markup.productGroupCount;
        groupsWithVariantCount += markup.groupsWithVariantCount;
        variantProductNodeCount += markup.variantProductNodeCount;
        absoluteTypeIriCount += markup.absoluteTypeIriCount;
        item.canonicalVariants = parseCanonicalMarketplaceVariantEvidence(detailHtml, item.productUrl);
        // Amazon pages often expose child ASINs in their explicit variation map
        // even when they omit Schema.org ProductGroup.hasVariant. Resolve those
        // ASINs against each child's own detail page; never inherit the parent's
        // JAN/GTIN, and persist only child pages with a valid concrete barcode.
        {
          // Do not stop at a partial Schema.org variant list: some entries have
          // only ASIN/option labels and no sellable identifier. Retry explicit
          // child ASINs whose existing evidence lacks a concrete barcode, then
          // merge recovered child-page evidence by ASIN without duplicating rows.
          const childAsins = parseAmazonVariationAsinMap(detailHtml, item.productUrl).slice(0, 6);
          variationAsinsFound += childAsins.length;
          const childAsinsNeedingBarcode = childAsins.filter((child) => {
            const existing = item.canonicalVariants.find((variant) => variant.asin === child.asin);
            return !existing || !(existing.jan || existing.gtin || existing.ean || existing.upc);
          });
          childDetailAttempted += childAsinsNeedingBarcode.length;
          const recovered = await Promise.all(childAsinsNeedingBarcode.map(async (child) => {
            const childUrl = `https://www.amazon.co.jp/dp/${child.asin}`;
            const childHtml = await fetchHtml(childUrl, { retryBrightDataWhenAmazonIdentifierMissing: true });
            if (!childHtml) return null;
            childDetailFetched += 1;
            const childDetail = parseAmazonProductDetail(childHtml);
            const jan = normalizeIdentifier("jan", childDetail.jan);
            const gtin = normalizeIdentifier("gtin", childDetail.gtin);
            const ean = normalizeIdentifier("ean", childDetail.ean);
            const upc = normalizeIdentifier("upc", childDetail.upc);
            if (!jan && !gtin && !ean && !upc) return null;
            childBarcodeFound += 1;
            return {
              sourceVariantId: child.asin,
              sku: null,
              title: child.variationValues.length ? child.variationValues.join(" / ") : null,
              asin: child.asin,
              jan,
              gtin,
              ean,
              upc,
              mpn: normalizeIdentifier("mpn", childDetail.model),
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
                extraction: "child_detail_page",
              },
            };
          }));
          for (const variant of recovered) {
            if (!variant) continue;
            const existingIndex = item.canonicalVariants.findIndex((existing) => existing.asin === variant.asin);
            if (existingIndex >= 0) {
              item.canonicalVariants[existingIndex] = { ...item.canonicalVariants[existingIndex], ...variant };
            } else {
              item.canonicalVariants.push(variant);
            }
          }
        }
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
      groupsWithVariantCount,
      variantProductNodeCount,
      absoluteTypeIriCount,
      variationAsinsFound,
      childDetailAttempted,
      childDetailFetched,
      childBarcodeFound,
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



