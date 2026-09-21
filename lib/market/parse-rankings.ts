import { decodeHtmlEntities } from "@/lib/market/html-entities";
import { extractAsinFromUrl, normalizeIdentifier } from "@/lib/market/identifiers";

export type ParsedBestseller = {
  rank: number | null;
  title: string;
  brand: string | null;
  model: string | null;
  asin: string | null;
  jan: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  mpn: string | null;
  price: number | null;
  currency: string | null;
  reviewCount: number | null;
  productUrl: string | null;
  imageUrl: string | null;
};

function decode(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function parseYen(text: string): { amount: number; currency: "JPY" } | null {
  const match = text.replace(/,/g, "").match(/(?:¥|￥|円)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    const loose = text.replace(/,/g, "").match(/([0-9]{3,})\s*円/);
    if (!loose) return null;
    const amount = Number(loose[1]);
    return Number.isFinite(amount) ? { amount, currency: "JPY" } : null;
  }
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? { amount, currency: "JPY" } : null;
}

function absoluteUrl(href: string, origin: string): string | null {
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

export function parseAmazonBestsellersHtml(html: string): ParsedBestseller[] {
  const items: ParsedBestseller[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/id="gridItemRoot"|zg-item-immersion|zg-grid-general-faceout/);

  for (const block of blocks.slice(1)) {
    const asinAttrMatch = block.match(/data-asin="([A-Za-z0-9]{10})"/i);
    const asinUrlMatch = block.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})/i);
    const rankMatch = block.match(/#\s*([0-9]{1,3})\b/) ??
      block.match(/zg-bdg-text[^>]*>\s*#?([0-9]{1,3})/i);
    const rank = rankMatch ? Number(rankMatch[1]) : null;
    const titleMatch =
      block.match(/alt="([^"]{4,200})"/) ??
      block.match(/p13n-sc-truncate[^>]*>([^<]{4,200})/i) ??
      block.match(/_cDEzb_p13n-sc-css-line-clamp[^>]*>([^<]{4,200})/);
    const title = titleMatch ? decode(titleMatch[1]) : "";
    const hrefMatch = block.match(/href="([^"]*\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^"]*)"/i);
    const imageMatch = block.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    const priceParsed = parseYen(block);
    const reviewMatch = block.match(/([0-9,]+)\s*(?:ratings|件)/i);

    const productUrl = hrefMatch ? absoluteUrl(hrefMatch[1], "https://www.amazon.co.jp") : null;
    // ASIN can live on the `data-asin` attribute, in the in-block URL, or
    // only survive on the outbound product link (e.g. when the block
    // boundary happens to fall between `data-asin` and the rest of the
    // card). Falling back to the URL keeps ASIN extraction reliable even
    // when Amazon's markup order shifts.
    const asin =
      normalizeIdentifier("asin", asinAttrMatch?.[1] ?? null) ??
      normalizeIdentifier("asin", asinUrlMatch?.[1] ?? null) ??
      extractAsinFromUrl(productUrl);

    if (!title && !asin) continue;
    const key = asin ?? title;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rank: Number.isFinite(rank) ? rank : items.length + 1,
      title: title || `Amazon ASIN ${asin}`,
      brand: null,
      model: null,
      asin,
      jan: null,
      gtin: null,
      ean: null,
      upc: null,
      mpn: null,
      price: priceParsed?.amount ?? null,
      currency: priceParsed?.currency ?? (priceParsed ? "JPY" : null),
      reviewCount: reviewMatch
        ? Number(reviewMatch[1].replace(/,/g, ""))
        : null,
      productUrl: productUrl ?? (asin ? `https://www.amazon.co.jp/dp/${asin}` : null),
      imageUrl: imageMatch?.[1] ?? null,
    });
  }

  return items.slice(0, 50);
}

export function parseRakutenRankingHtml(html: string): ParsedBestseller[] {
  const items: ParsedBestseller[] = [];
  const seen = new Set<string>();
  const linkRe =
    /<a[^>]+href="(https?:\/\/item\.rakuten\.co\.jp\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let rank = 1;

  while ((match = linkRe.exec(html)) && items.length < 50) {
    const url = match[1];
    const inner = match[2];
    const title =
      decode(inner.replace(/<[^>]+>/g, " ")).slice(0, 200) ||
      decode((html.slice(match.index, match.index + 400).match(/alt="([^"]+)"/) ?? [])[1] ?? "");
    if (!title || title.length < 4) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const nearby = html.slice(Math.max(0, match.index - 200), match.index + 800);
    const priceParsed = parseYen(nearby);
    const imageMatch = nearby.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);

    items.push({
      rank,
      title,
      brand: null,
      model: null,
      asin: null,
      jan: null,
      gtin: null,
      ean: null,
      upc: null,
      mpn: null,
      price: priceParsed?.amount ?? null,
      currency: priceParsed?.currency ?? null,
      reviewCount: null,
      productUrl: url,
      imageUrl: imageMatch?.[1] ?? null,
    });
    rank += 1;
  }

  return items;
}

// Yahoo!ショッピングの実際の商品ページは
// https://store.shopping.yahoo.co.jp/{shop-id}/{item-code}.html という
// 2階層・.html終端の形式に限られる。同じドメイン配下にショップTOP
// (/{shop-id}/)、カテゴリ一覧、レビュー、キャンペーン、ガイドページ等が
// 同居しているため、パス構造とセグメント名の両方で厳格に絞り込む。
const YAHOO_PRODUCT_PATH = /^\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*\.html$/i;
const YAHOO_NON_PRODUCT_SEGMENTS = new Set([
  "review",
  "reviews",
  "campaign",
  "campaigns",
  "guide",
  "guides",
  "feature",
  "features",
  "shopguide",
  "shopinfo",
  "info",
  "news",
  "ranking",
  "search",
  "cart",
  "member",
  "help",
  "category",
  "categories",
]);

export function isYahooProductUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.hostname !== "store.shopping.yahoo.co.jp") return false;
  if (!YAHOO_PRODUCT_PATH.test(parsed.pathname)) return false;

  const segments = parsed.pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/\.html$/, ""));
  if (segments.some((segment) => YAHOO_NON_PRODUCT_SEGMENTS.has(segment))) return false;

  return true;
}

export function parseYahooRankingHtml(html: string): ParsedBestseller[] {
  const items: ParsedBestseller[] = [];
  const seen = new Set<string>();
  const linkRe =
    /<a[^>]+href="(https?:\/\/store\.shopping\.yahoo\.co\.jp\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let rank = 1;

  while ((match = linkRe.exec(html)) && items.length < 50) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isYahooProductUrl(url)) continue;
    const inner = decode(match[2].replace(/<[^>]+>/g, " ")).slice(0, 200);
    const nearby = html.slice(Math.max(0, match.index - 200), match.index + 900);
    const title =
      inner.length >= 4
        ? inner
        : decode((nearby.match(/alt="([^"]{4,200})"/) ?? [])[1] ?? "");
    if (!title || title.length < 4) continue;
    const priceParsed = parseYen(nearby);
    const imageMatch = nearby.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);

    items.push({
      rank,
      title,
      brand: null,
      model: null,
      asin: null,
      jan: null,
      gtin: null,
      ean: null,
      upc: null,
      mpn: null,
      price: priceParsed?.amount ?? null,
      currency: priceParsed?.currency ?? null,
      reviewCount: null,
      productUrl: url,
      imageUrl: imageMatch?.[1] ?? null,
    });
    rank += 1;
  }

  return items;
}

export function parseAmazonProductDetail(html: string): {
  brand: string | null;
  jan: string | null;
  model: string | null;
} {
  const jan =
    html.match(/<th[^>]*>\s*JAN\s*<\/th>\s*<td[^>]*>\s*([0-9]{8,13})/i)?.[1] ??
    html.match(/JAN[^\d]{0,12}([0-9]{8,13})/)?.[1] ??
    null;
  const brand =
    html.match(/id="bylineInfo"[^>]*>[\s\S]{0,80}>([^<]{2,80})/)?.[1] ??
    html.match(/ブランド[^\n<]{0,8}([^<]{2,80})/)?.[1] ??
    null;
  const model =
    html.match(/<th[^>]*>\s*(?:型番|メーカー型番)\s*<\/th>\s*<td[^>]*>\s*([^<]{2,80})/i)?.[1] ??
    null;

  return {
    brand: brand ? decode(brand).replace(/^ブランド:\s*/u, "") : null,
    jan,
    model: model ? decode(model) : null,
  };
}

/**
 * Extracts identity fields from a Yahoo!ショッピング product detail page
 * (the page a ranking link points to, e.g.
 * `store.shopping.yahoo.co.jp/{shop}/{item}.html`). Mirrors
 * `parseAmazonProductDetail`'s contract: returns raw, unnormalized digits
 * (or null); the caller normalizes via `normalizeIdentifier("jan", ...)`
 * the same way it already does for Amazon, so normalization stays in one
 * place instead of being duplicated per marketplace.
 *
 * The spec table uses a "JAN/ISBNコード" heading (not a bare "JAN"), and
 * React-rendered shop templates sometimes split text nodes with empty
 * `<!-- -->` comments, so both are handled explicitly rather than assumed
 * away by a naive Amazon-style regex.
 */
export function parseYahooProductDetail(html: string): {
  jan: string | null;
} {
  const cleaned = stripHtmlComments(html);

  const jan =
    cleaned.match(/<th[^>]*>\s*JAN(?:\/ISBN)?コード\s*<\/th>\s*<td[^>]*>\s*([0-9]{8,13})/i)?.[1] ??
    cleaned.match(/JAN(?:\/ISBN)?コード[^\d]{0,20}([0-9]{8,13})/i)?.[1] ??
    null;

  return { jan };
}

export function verifyBestsellerParseInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const amazon = parseAmazonBestsellersHtml(`
    <div id="gridItemRoot" data-asin="B0TESTASIN">
      <span class="zg-bdg-text">#1</span>
      <a href="/dp/B0TESTASIN/ref=zg">
        <img alt="Test Floor Mat" src="https://images-na.ssl-images-amazon.com/images/I/test.jpg" />
      </a>
      <span class="p13n-sc-price">￥3,980</span>
    </div>
  `);

  const empty = parseAmazonBestsellersHtml("<html></html>");

  // ASIN only survives on the outbound link, not on a `data-asin`
  // attribute inside the same block (e.g. markup order shifted). ASIN
  // extraction must still succeed via the product URL fallback.
  const amazonAsinFromUrlOnly = parseAmazonBestsellersHtml(`
    <div id="gridItemRoot">
      <span class="zg-bdg-text">#2</span>
      <a href="/dp/B0URLONLY9/ref=zg">
        <img alt="URL Only Product" src="https://images-na.ssl-images-amazon.com/images/I/test2.jpg" />
      </a>
      <span class="p13n-sc-price">￥1,980</span>
    </div>
  `);

  const yahooRankingHtml = `
    <a href="https://store.shopping.yahoo.co.jp/teamo/">Shop top page, not a product</a>
    <a href="https://store.shopping.yahoo.co.jp/teamo/review/12345.html">Reviews for this item</a>
    <a href="https://store.shopping.yahoo.co.jp/teamo/campaign/summer.html">Summer campaign</a>
    <a href="https://store.shopping.yahoo.co.jp/teamo/teamoclear.html">TeAmo コンタクトレンズ ワンデー 2箱セット ￥3,278&#12316;</a>
  `;
  const yahoo = parseYahooRankingHtml(yahooRankingHtml);

  const yahooDetail = parseYahooProductDetail(`
    <table><tbody>
      <tr class="styles_row__ANXSu"><th class="styles_heading__M3H48">JAN/ISBNコード</th><td class="styles_data__LgOoo">4573138107287</td></tr>
      <tr class="styles_row__ANXSu"><th class="styles_heading__M3H48">商品<!-- -->コード</th><td class="styles_data__LgOoo">teamoclear</td></tr>
    </tbody></table>
  `);

  const cases = [
    {
      name: "amazon_extracts_asin_rank_price",
      expected: true,
      actual:
        amazon[0]?.asin === "B0TESTASIN" &&
        amazon[0]?.rank === 1 &&
        amazon[0]?.price === 3980,
    },
    {
      name: "empty_html_does_not_invent_items",
      expected: true,
      actual: empty.length === 0,
    },
    {
      name: "amazon_asin_recovered_from_product_url_when_attribute_missing",
      expected: true,
      actual: amazonAsinFromUrlOnly[0]?.asin === "B0URLONLY9",
    },
    {
      name: "yahoo_excludes_shop_top_review_and_campaign_pages",
      expected: true,
      actual:
        yahoo.every((item) => !item.productUrl?.includes("/teamo/review/")) &&
        yahoo.every((item) => !item.productUrl?.includes("/teamo/campaign/")) &&
        yahoo.every((item) => item.productUrl !== "https://store.shopping.yahoo.co.jp/teamo/"),
    },
    {
      name: "yahoo_keeps_genuine_product_page",
      expected: true,
      actual:
        yahoo.length === 1 &&
        yahoo[0]?.productUrl === "https://store.shopping.yahoo.co.jp/teamo/teamoclear.html",
    },
    {
      name: "yahoo_title_decodes_numeric_entity_instead_of_mojibake",
      expected: true,
      actual: yahoo[0]?.title.includes("\u301c") && !yahoo[0]?.title.includes("&#12316;"),
    },
    {
      name: "yahoo_product_url_rejects_non_product_paths",
      expected: true,
      actual:
        !isYahooProductUrl("https://store.shopping.yahoo.co.jp/teamo/") &&
        !isYahooProductUrl("https://store.shopping.yahoo.co.jp/teamo/review/1.html") &&
        isYahooProductUrl("https://store.shopping.yahoo.co.jp/teamo/teamoclear.html"),
    },
    {
      name: "yahoo_product_detail_extracts_jan_despite_react_comment_split",
      expected: true,
      actual: yahooDetail.jan === "4573138107287",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
