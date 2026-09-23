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
 * Finds every `<script type="application/ld+json">` block and returns any
 * node shaped like schema.org's Product type (including nested under
 * `@graph`, which many storefront templates use). This is a real,
 * widely-published web standard — GS1 itself documents `gtin`/`gtin13` as
 * the recommended schema.org property for exactly this purpose — not a
 * guess at Yahoo's internal markup. Malformed/unrelated JSON-LD blocks are
 * skipped rather than throwing.
 */
function findJsonLdProducts(html: string): Array<Record<string, unknown>> {
  const products: Array<Record<string, unknown>> = [];
  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }

    const nodes: unknown[] = [];
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(parsed)) nodes.push(...parsed);
    else if (Array.isArray(root?.["@graph"])) nodes.push(...(root["@graph"] as unknown[]));
    else nodes.push(parsed);

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      const type = record["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (isProduct) products.push(record);
    }
  }

  return products;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/**
 * Extracts identity fields from a Yahoo!ショッピング product detail page
 * (the page a ranking link points to, e.g.
 * `store.shopping.yahoo.co.jp/{shop}/{item}.html`). Mirrors
 * `parseAmazonProductDetail`'s contract: returns raw, unnormalized digits
 * (or null); the caller normalizes via `normalizeIdentifier(...)` the same
 * way it already does for Amazon, so normalization stays in one place
 * instead of being duplicated per marketplace.
 *
 * Two independent sources are checked, since either may be present or
 * absent depending on the shop's template:
 * 1. The spec table's "JAN/ISBNコード" heading (not a bare "JAN"); React-
 *    rendered shop templates sometimes split text nodes with empty
 *    `<!-- -->` comments, so both are handled explicitly rather than
 *    assumed away by a naive Amazon-style regex.
 * 2. schema.org Product JSON-LD (`gtin13`/`gtin`/`mpn`/`brand.name`), a
 *    machine-readable format shops publish specifically so identifiers can
 *    be extracted without guessing at page structure. Returned as `gtin`
 *    (never `jan`), since JSON-LD's `gtin`/`gtin13` does not itself assert
 *    Japan's specific JAN registration — the caller's cross-scheme
 *    matching (lib/market/identifiers.ts) already treats JAN/GTIN as the
 *    same GS1 numbering space, so this does not weaken matching.
 */
export function parseYahooProductDetail(html: string): {
  jan: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
} {
  const cleaned = stripHtmlComments(html);

  const jan =
    cleaned.match(/<th[^>]*>\s*JAN(?:\/ISBN)?コード\s*<\/th>\s*<td[^>]*>\s*([0-9]{8,13})/i)?.[1] ??
    cleaned.match(/JAN(?:\/ISBN)?コード[^\d]{0,20}([0-9]{8,13})/i)?.[1] ??
    null;

  let gtin: string | null = null;
  let mpn: string | null = null;
  let brand: string | null = null;

  for (const product of findJsonLdProducts(html)) {
    if (!gtin) {
      const candidate =
        firstString(product.gtin13) ??
        firstString(product.gtin) ??
        firstString(product.gtin12) ??
        firstString(product.gtin8) ??
        firstString(product.gtin14);
      if (candidate) gtin = candidate;
    }
    if (!mpn) mpn = firstString(product.mpn);
    if (!brand) {
      const brandField = product.brand;
      brand =
        firstString(brandField) ??
        (brandField && typeof brandField === "object"
          ? firstString((brandField as Record<string, unknown>).name)
          : null);
    }
    if (gtin && mpn && brand) break;
  }

  return { jan, gtin, mpn, brand };
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

  const yahooDetailJsonLdOnly = parseYahooProductDetail(`
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Example","mpn":"MPN-7788",
       "brand":{"@type":"Brand","name":"TeAmo"},"gtin13":"4901234567894"}
    </script>
  `);

  const yahooDetailJsonLdInGraph = parseYahooProductDetail(`
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"BreadcrumbList","itemListElement":[]},
        {"@type":"Product","name":"Example2","gtin":"4901234500009"}
      ]}
    </script>
  `);

  const yahooDetailIgnoresNonProductJsonLd = parseYahooProductDetail(`
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}
    </script>
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
    {
      name: "yahoo_product_detail_extracts_gtin_mpn_brand_from_json_ld",
      expected: true,
      actual:
        yahooDetailJsonLdOnly.gtin === "4901234567894" &&
        yahooDetailJsonLdOnly.mpn === "MPN-7788" &&
        yahooDetailJsonLdOnly.brand === "TeAmo",
    },
    {
      name: "yahoo_product_detail_finds_json_ld_product_nested_in_graph",
      expected: true,
      actual: yahooDetailJsonLdInGraph.gtin === "4901234500009",
    },
    {
      name: "yahoo_product_detail_ignores_non_product_json_ld",
      expected: true,
      actual: yahooDetailIgnoresNonProductJsonLd.gtin === null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
