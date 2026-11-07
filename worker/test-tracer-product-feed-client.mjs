import assert from "node:assert/strict";
import { createTracerProductFeedClient } from "./tracer-product-feed-client.mjs";

const now = Date.now();
const token = "test-worker-token-that-is-long-enough-for-authentication";
let captured;
const fetchImpl = async (url, options) => {
  captured = { url: String(url), options };
  return new Response(JSON.stringify({
    ok: true,
    readOnly: true,
    products: [
      {
        id: "listing-01",
        title: "日本語商品",
        sellingPrice: 2980,
        inStock: true,
        productUrl: "https://tracer.base.ec/items/123",
        factsVersion: "facts-v1",
        factsVerifiedAt: new Date(now - 30_000).toISOString(),
        scriptText: "日本語の商品紹介です。",
      },
      {
        id: "stale-listing",
        title: "古い商品",
        sellingPrice: 1000,
        inStock: true,
        productUrl: "https://tracer.base.ec/items/456",
        factsVersion: "facts-old",
        factsVerifiedAt: new Date(now - 16 * 60_000).toISOString(),
        scriptText: "古い商品情報です。",
      },
      {
        id: "foreign-url",
        title: "不正URL",
        sellingPrice: 1000,
        inStock: true,
        productUrl: "https://example.com/items/456",
        factsVersion: "facts-v1",
        factsVerifiedAt: new Date(now).toISOString(),
        scriptText: "対象外URLです。",
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
};
const load = createTracerProductFeedClient({
  baseUrl: "https://tracer-pied-alpha.vercel.app",
  workerToken: token,
  fetchImpl,
  now: () => now,
});
const segments = await load({ limit: 10 });
assert.equal(segments.length, 1);
assert.deepEqual(segments[0], {
  id: "product-listing-01",
  productId: "listing-01",
  scriptText: "日本語の商品紹介です。",
  factsVersion: "facts-v1",
  factsVerifiedAt: new Date(now - 30_000).toISOString(),
});
assert.equal(captured.url, "https://tracer-pied-alpha.vercel.app/api/admin/ai-live/products?limit=20");
assert.equal(captured.options.headers.authorization, `Bearer ${token}`);
assert.throws(() => createTracerProductFeedClient({ baseUrl: "http://insecure.example", workerToken: token }), /configuration_invalid/);
console.log("TRACER canonical product feed client: all assertions passed");
