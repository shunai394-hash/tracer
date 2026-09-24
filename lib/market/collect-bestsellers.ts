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
  {
    marketplace: "amazon.co.jp",
    url: "https://www.amazon.co.jp/gp/bestsellers/",
    source: "amazon_bestsellers",
  },
  {
    marketplace: "rakuten",
    url: "https://ranking.rakuten.co.jp/",
    source: "rakuten_ranking",
  },
  {
    marketplace: "yahoo_shopping",
    url: "https://shopping.yahoo.co.jp/ranking/",
    source: "yahoo_shopping_ranking",
  },
] as const;

/**
 * How many collected items per marketplace get a detail-page fetch for
 * identifier enrichment. Fetches run in parallel (Promise.all), so this is
 * a fan-out safety bound, not a latency budget — raising it does not
 * multiply wall-clock time the way the old sequential loop did.
 */
const DETAIL_ENRICHMENT_LIMIT = 20;

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

export async function collectMarketplaceBestsellers(): Promise<{
  fetchedAt: string;
  marketplaces: CollectedMarketplace[];
  itemCount: number;
}> {
  const fetchedAt = new Date().toISOString();
  const marketplaces: CollectedMarketplace[] = [];

  for (const source of MARKETPLACE_SOURCES) {
    try {
      const html = await fetchHtml(source.url);
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
      let enrichment: { attempted: number; htmlFetched: number; identifierFound: number } | undefined;

      if (source.marketplace === "amazon.co.jp") {
        const details = items.slice(0, DETAIL_ENRICHMENT_LIMIT);
        let htmlFetched = 0;
        let identifierFound = 0;
        await Promise.all(
          details.map(async (item) => {
            if (!item.productUrl) return;
            try {
              const detailHtml = await fetchHtml(item.productUrl);
              if (!detailHtml) return;
              htmlFetched += 1;
              const detail = parseAmazonProductDetail(detailHtml);
              item.brand = detail.brand;
              item.model = detail.model;
              item.jan = normalizeIdentifier("jan", detail.jan);
              item.mpn = normalizeIdentifier("mpn", detail.model);
              if (item.jan || item.mpn) identifierFound += 1;
            } catch {
              // Detail pages stay unknown rather than blocking the listing.
            }
          }),
        );
        enrichment = { attempted: details.length, htmlFetched, identifierFound };
      }

      if (source.marketplace === "yahoo_shopping") {
        const details = items.slice(0, DETAIL_ENRICHMENT_LIMIT);
        let htmlFetched = 0;
        let identifierFound = 0;
        await Promise.all(
          details.map(async (item) => {
            if (!item.productUrl) return;
            try {
              const detailHtml = await fetchHtml(item.productUrl);
              if (!detailHtml) return;
              htmlFetched += 1;
              const detail = parseYahooProductDetail(detailHtml);
              item.jan = normalizeIdentifier("jan", detail.jan);
              item.gtin = normalizeIdentifier("gtin", detail.gtin);
              item.mpn = normalizeIdentifier("mpn", detail.mpn);
              item.brand = detail.brand;
              if (item.jan || item.gtin || item.mpn) identifierFound += 1;
            } catch {
              // Detail pages stay unknown rather than blocking the listing.
            }
          }),
        );
        enrichment = { attempted: details.length, htmlFetched, identifierFound };
      }

      marketplaces.push({
        marketplace: source.marketplace,
        source: source.source,
        sourceUrl: source.url,
        fetchedAt,
        items,
        enrichment,
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

  return {
    fetchedAt,
    marketplaces,
    itemCount: marketplaces.reduce((sum, item) => sum + item.items.length, 0),
  };
}



