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

export type CollectedMarketplace = {
  marketplace: string;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  items: ParsedBestseller[];
  skipped?: boolean;
  reason?: string;
};

async function fetchHtml(url: string): Promise<string | null> {
  if (isBrightDataConfigured()) {
    const page = await fetchBrightDataPage(url);
    return page.html;
  }

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; TRACER-bestseller-collector/1.0)",
        Accept: "text/html",
      },
    });
    if (!response.ok) return null;
    // `response.text()` decodes strictly by the Content-Type charset
    // (defaulting to UTF-8 when absent). Some shop pages only declare
    // their encoding via `<meta charset>`, so bytes are read raw and
    // decoded with charset detection that also checks the document body.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const html = decodeHtmlBytes(bytes, response.headers.get("content-type"));
    return html.includes("<") ? html : null;
  } catch {
    return null;
  }
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
      if (source.marketplace === "amazon.co.jp") {
        const details = items.slice(0, 8);
        for (const item of details) {
          if (!item.productUrl) continue;
          try {
            const detailHtml = await fetchHtml(item.productUrl);
            if (!detailHtml) continue;
            const detail = parseAmazonProductDetail(detailHtml);
            item.brand = detail.brand;
            item.model = detail.model;
            item.jan = normalizeIdentifier("jan", detail.jan);
            item.mpn = normalizeIdentifier("mpn", detail.model);
          } catch {
            // Detail pages stay unknown rather than blocking the listing.
          }
        }
      }

      if (source.marketplace === "yahoo_shopping") {
        const details = items.slice(0, 8);
        for (const item of details) {
          if (!item.productUrl) continue;
          try {
            const detailHtml = await fetchHtml(item.productUrl);
            if (!detailHtml) continue;
            const detail = parseYahooProductDetail(detailHtml);
            item.jan = normalizeIdentifier("jan", detail.jan);
          } catch {
            // Detail pages stay unknown rather than blocking the listing.
          }
        }
      }

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

  return {
    fetchedAt,
    marketplaces,
    itemCount: marketplaces.reduce((sum, item) => sum + item.items.length, 0),
  };
}
