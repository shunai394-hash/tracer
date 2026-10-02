import "server-only";

const PUBLIC_SEARCH_URL = "https://www.superdelivery.com/p/do/psl/";
const REQUEST_TIMEOUT_MS = 15_000;

export type SuperDeliveryProductSet = {
  makerProductCode: string | null;
  sdProductCode: string | null;
  setNo: string | null;
  title: string | null;
  janCode: string | null;
  stock: number | null;
  exhibitState: number | null;
  price: number | null;
  imageUrl: string | null;
  productUrl: string | null;
  raw: Record<string, unknown>;
};

export class SuperDeliveryConfigError extends Error {
  readonly code = "SUPERDELIVERY_NOT_CONFIGURED" as const;
}

export class SuperDeliveryRequestError extends Error {
  readonly code = "SUPERDELIVERY_REQUEST_FAILED" as const;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href: string): string {
  return href.startsWith("http") ? href : `https://www.superdelivery.com${href}`;
}

function productLinks(html: string): string[] {
  const links = new Set<string>();
  const re = /href=["']([^"']*\/p\/r\/pd_p\/\d+\/?)["']/gi;
  for (const match of html.matchAll(re)) links.add(absoluteUrl(match[1]));
  return [...links];
}

function findJan(text: string): string | null {
  const match = text.match(/(?:JAN(?:コード)?|JAN)\s*[：:]?\s*(\d{13})/i);
  return match?.[1] ?? null;
}

function findSdCode(text: string): string | null {
  const match = text.match(/SD品番\s*[：:]?\s*([A-Za-z0-9-]+)/i);
  return match?.[1] ?? null;
}

function findMakerCode(text: string): string | null {
  const match = text.match(/(?:メーカー品番|商品コード)\s*[：:]?\s*[〖「]?([A-Za-z0-9_-]+)[〗」]?/i);
  return match?.[1] ?? null;
}

function findTitle(html: string, text: string): string | null {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) {
    const normalized = textFromHtml(title).replace(/\s*商品ページ.*$/i, "").trim();
    if (normalized) return normalized;
  }
  const janIndex = text.indexOf("JAN");
  const prefix = janIndex > 0 ? text.slice(Math.max(0, janIndex - 220), janIndex) : text.slice(0, 220);
  return prefix.trim() || null;
}

function findStock(text: string): number | null {
  if (/SOLD\s*OUT|完売|在庫なし/i.test(text)) return 0;
  if (/在庫あり|在庫有り/i.test(text)) return 1;
  return null;
}

function findImage(html: string): string | null {
  const match = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
  return match?.[1] ? absoluteUrl(match[1]) : null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "TRACER/1.0 (+public-product-discovery)",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SuperDeliveryRequestError(`SUPER DELIVERY public page HTTP ${response.status}`);
  }
  return response.text();
}

async function searchPublicProducts(jan: string): Promise<SuperDeliveryProductSet[]> {
  const normalized = jan.trim();
  if (!/^\d{13}$/.test(normalized)) return [];

  const url = new URL(PUBLIC_SEARCH_URL);
  url.searchParams.set("word", normalized);

  const html = await fetchText(url.toString());
  const links = productLinks(html).slice(0, 5);
  const results: SuperDeliveryProductSet[] = [];

  for (const productUrl of links) {
    const detailHtml = await fetchText(productUrl);
    const text = textFromHtml(detailHtml);
    const detailJan = findJan(text);
    if (detailJan !== normalized) continue;

    const sdProductCode = findSdCode(text);
    const makerProductCode = findMakerCode(text);
    results.push({
      makerProductCode,
      sdProductCode,
      setNo: null,
      title: findTitle(detailHtml, text),
      janCode: detailJan,
      stock: findStock(text),
      exhibitState: /SOLD\s*OUT|完売|在庫なし/i.test(text) ? 3 : 2,
      price: null,
      imageUrl: findImage(detailHtml),
      productUrl,
      raw: {
        source: "superdelivery_public_search",
        observedText: text.slice(0, 4000),
      },
    });
  }

  return results;
}

export async function getSuperDeliveryCatalog(): Promise<SuperDeliveryProductSet[]> {
  return [];
}

export async function searchSuperDeliveryProducts(query: string): Promise<SuperDeliveryProductSet[]> {
  return searchPublicProducts(query);
}

export async function findSuperDeliveryProductsByJan(
  _catalog: SuperDeliveryProductSet[],
  jan: string,
): Promise<SuperDeliveryProductSet[]> {
  return searchPublicProducts(jan);
}

export async function getSuperDeliveryProduct(productCode: string): Promise<SuperDeliveryProductSet | null> {
  const normalized = productCode.trim();
  if (!normalized) return null;
  const results = await searchPublicProducts(normalized);
  return results.find(
    (item) =>
      item.sdProductCode === normalized ||
      item.makerProductCode === normalized,
  ) ?? null;
}
