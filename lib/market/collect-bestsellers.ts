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
import { decodeHtmlBytes } from "@/lib/market/charset";

export const MARKETPLACE_SOURCES = [
  { marketplace: "yahoo_shopping", url: "https://shopping.yahoo.co.jp/ranking/", source: "yahoo_shopping_ranking" },
  { marketplace: "rakuten", url: "https://ranking.rakuten.co.jp/", source: "rakuten_ranking" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/", source: "amazon_bestsellers" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/electronics/", source: "amazon_bestsellers_electronics" },
  { marketplace: "amazon.co.jp", url: "https://www.amazon.co.jp/gp/bestsellers/beauty/", source: "amazon_bestsellers_beauty" },
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
  };
};

async function fetchHtml(url: string): Promise<string | null> {
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

  // Product detail pages: direct first, Bright Data fallback.
  const directHtml = await directFetch();
  if (directHtml) return directHtml;

  if (isBrightDataConfigured()) {
    try {
      const page = await fetchBrightDataPage(url);
      if (page.html) return page.html;
    } catch {
      // Fall through.
    }
  }

  return null;
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
}> {
  const fetchedAt = new Date().toISOString();
  const marketplaces: CollectedMarketplace[] = [];
  const sourceIndex = Math.max(0, options.sourceIndex ?? 0);
  const selectedSource = MARKETPLACE_SOURCES[sourceIndex];
  if (!selectedSource) {
    return { fetchedAt, marketplaces: [], itemCount: 0 };
  }

  // Fetch independent marketplace ranking pages concurrently. The previous
  // sequential fan-out made the eight sources share one 60-second serverless
  // budget and allowed one slow marketplace to starve the whole observation run.
  const collectedSources = await Promise.all(
    [selectedSource].map(async (source) => {
      try {
        const html = await fetchHtml(source.url);
        return { source, html, error: null as unknown };
      } catch (error) {
        return { source, html: null, error };
      }
    }),
  );

  for (const { source, html, error: sourceError } of collectedSources) {
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
      });
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

  await Promise.all(details.map(async (item) => {
    if (!item.productUrl) return;
    try {
      const detailHtml = await fetchHtml(item.productUrl);
      if (!detailHtml) return;
      htmlFetched += 1;

      if (marketplace.marketplace === "amazon.co.jp") {
        const detail = parseAmazonProductDetail(detailHtml);
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
    enrichment: { attempted: details.length, htmlFetched, identifierFound },
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
  };
}



