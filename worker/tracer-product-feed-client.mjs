const MAX_FACT_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function isFresh(timestamp, now) {
  return Number.isFinite(timestamp) &&
    timestamp <= now + MAX_FUTURE_SKEW_MS &&
    now - timestamp <= MAX_FACT_AGE_MS;
}

/**
 * Loads the canonical, read-only TRACER feed and maps it to worker segments.
 * The worker token is sent only in the server-to-server Authorization header.
 */
export function createTracerProductFeedClient({
  baseUrl,
  workerToken,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//.test(baseUrl) ||
      typeof workerToken !== "string" || workerToken.length < 32 ||
      typeof fetchImpl !== "function" || typeof now !== "function") {
    throw new Error("tracer_product_feed_configuration_invalid");
  }
  const endpoint = new URL("/api/admin/ai-live/products?limit=20", baseUrl);

  return async function loadVerifiedProductSegments({ limit = 20 } = {}) {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${workerToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("tracer_product_feed_request_failed");
    const payload = await response.json();
    if (payload?.ok !== true || payload?.readOnly !== true ||
        !Array.isArray(payload.products)) {
      throw new Error("tracer_product_feed_response_invalid");
    }
    const currentTime = now();
    const segments = payload.products.flatMap((product) => {
      if (!product || typeof product !== "object" ||
          typeof product.id !== "string" || !/^[A-Za-z0-9_-]{1,88}$/.test(product.id) ||
          typeof product.title !== "string" || !product.title.trim() ||
          typeof product.scriptText !== "string" || !product.scriptText.trim() ||
          product.scriptText.length > 5000 ||
          product.inStock !== true ||
          typeof product.sellingPrice !== "number" ||
          !Number.isFinite(product.sellingPrice) || product.sellingPrice <= 0 ||
          typeof product.factsVersion !== "string" || !product.factsVersion ||
          typeof product.factsVerifiedAt !== "string" ||
          !isFresh(Date.parse(product.factsVerifiedAt), currentTime) ||
          typeof product.productUrl !== "string") return [];
      let productUrl;
      try { productUrl = new URL(product.productUrl); } catch { return []; }
      if (productUrl.protocol !== "https:" || productUrl.hostname !== "tracer.base.ec") return [];
      return [{
        id: `product-${product.id}`,
        productId: product.id,
        scriptText: product.scriptText,
        factsVersion: product.factsVersion,
        factsVerifiedAt: product.factsVerifiedAt,
      }];
    });
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(20, limit)) : 20;
    return segments.slice(0, boundedLimit);
  };
}
