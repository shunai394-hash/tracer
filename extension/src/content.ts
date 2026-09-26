type ProductCapture = {
  url: string;
  title: string;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  asin: string | null;
  jan: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  mpn: string | null;
  brand: string | null;
};

function textFrom(selector: string): string | null {
  const node = document.querySelector(selector);
  const value = node?.textContent?.replace(/\\s+/g, " ").trim();
  return value || null;
}

function numberFromText(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractAsin(url: string): string | null {
  const match = url.match(/\\/(?:dp|gp\\/product|gp\\/aw\\/d)\\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function jsonLdObjects(): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || "");
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        if (value && typeof value === "object") {
          result.push(value as Record<string, unknown>);
        }
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function capture(): ProductCapture {
  const jsonLd = jsonLdObjects();
  const product = jsonLd.find((value) => {
    const type = value["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  }) ?? {};

  const offers = product.offers && typeof product.offers === "object"
    ? product.offers as Record<string, unknown>
    : {};

  const brandValue = product.brand && typeof product.brand === "object"
    ? (product.brand as Record<string, unknown>).name
    : product.brand;

  const title =
    textFrom("#productTitle") ??
    firstString(product.name) ??
    document.title.replace(/Amazon.*$/i, "").trim();

  const imageValue = Array.isArray(product.image)
    ? product.image[0]
    : product.image;

  const asin = extractAsin(location.href);

  const gtin = firstString(
    product.gtin13,
    product.gtin12,
    product.gtin14,
    product.gtin,
  );

  const priceText =
    textFrom("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen") ??
    textFrom("#priceblock_ourprice") ??
    textFrom("#priceblock_dealprice") ??
    firstString(offers.price);

  return {
    url: location.href,
    title,
    price: numberFromText(priceText),
    currency: firstString(offers.priceCurrency) ?? (location.hostname.endsWith(".co.jp") ? "JPY" : null),
    imageUrl:
      firstString(imageValue) ??
      document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ??
      null,
    asin,
    jan: null,
    gtin,
    ean: null,
    upc: firstString(product.gtin12),
    mpn: firstString(product.mpn),
    brand: firstString(brandValue),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TRACER_CAPTURE_PRODUCT") return false;

  try {
    sendResponse({ ok: true, product: capture() });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to capture product",
    });
  }

  return true;
});
