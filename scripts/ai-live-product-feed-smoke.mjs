#!/usr/bin/env node
/**
 * Authenticated smoke test for the AI-live read-only product feed.
 *
 * Required environment:
 *   TRACER_AI_LIVE_BASE_URL - deployed TRACER origin, e.g. https://tracer-pied-alpha.vercel.app
 *   CRON_SECRET             - existing server-side automation secret (never print it)
 *
 * This script only issues GET requests. It never changes commerce data.
 */
import assert from "node:assert/strict";

const baseUrl = process.env.TRACER_AI_LIVE_BASE_URL;
const secret = process.env.CRON_SECRET;

if (!baseUrl || !secret) {
  console.error("Missing TRACER_AI_LIVE_BASE_URL or CRON_SECRET; no request sent.");
  process.exitCode = 2;
} else {
  const origin = new URL(baseUrl);
  assert.ok(origin.protocol === "https:" || origin.hostname === "localhost",
    "Use HTTPS for non-local environments");
  assert.equal(origin.username, "", "Base URL must not embed credentials");
  assert.equal(origin.password, "", "Base URL must not embed credentials");

  const endpoint = new URL("/api/admin/ai-live/products?limit=20", origin);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status !== 200) {
    console.error(JSON.stringify({
      ok: false,
      stage: "authenticated_feed_request",
      status: response.status,
      note: "Response body omitted to avoid exposing internal diagnostics.",
    }));
    process.exitCode = 1;
  } else {
    const body = await response.json();
    assert.equal(body.ok, true, "Feed should return ok=true");
    assert.equal(body.readOnly, true, "Feed must declare readOnly=true");
    assert.ok(Array.isArray(body.products), "products must be an array");
    assert.ok(body.products.length <= 20, "Feed must respect the 20-item cap");
    assert.equal(body.count, body.products.length, "count must match products length");

    const forbiddenKeys = /cost|margin|profit|supplier|credential|secret|order|tracking_number|service_role/i;
    const allowedKeys = new Set([
      "id", "title", "description", "sellingPrice", "currency",
      "inStock", "productUrl", "updatedAt",
    ]);

    for (const item of body.products) {
      for (const key of Object.keys(item)) {
        assert.ok(!forbiddenKeys.test(key), `Forbidden key in response: ${key}`);
        assert.ok(allowedKeys.has(key), `Unexpected response key: ${key}`);
      }
      assert.equal(typeof item.title, "string");
      assert.ok(item.title.trim().length > 0);
      assert.equal(typeof item.sellingPrice, "number");
      assert.ok(Number.isFinite(item.sellingPrice) && item.sellingPrice > 0);
      assert.equal(item.inStock, true);
      assert.equal(typeof item.productUrl, "string");
      const productUrl = new URL(item.productUrl);
      assert.equal(productUrl.origin, "https://tracer.base.ec");
      assert.ok(productUrl.pathname.startsWith("/items/"));
      assert.ok(!item.description || typeof item.description === "string");
    }

    console.log(JSON.stringify({
      ok: true,
      status: response.status,
      readOnly: body.readOnly,
      count: body.products.length,
      checkedAt: new Date().toISOString(),
      checks: [
        "authenticated GET only",
        "response allowlist",
        "no supplier/cost/profit/order/secret fields",
        "positive price and in-stock contract",
        "BASE product URL origin and path",
        "20-item cap",
      ],
      note: "This verifies the feed contract, not the accuracy of the source system or live avatar speech.",
    }, null, 2));
  }
}
