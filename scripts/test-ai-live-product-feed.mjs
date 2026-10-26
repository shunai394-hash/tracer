import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(
  new URL("../app/api/admin/ai-live/products/route.ts", import.meta.url),
  "utf8",
);

// The feed must be protected and read-only.
assert.match(route, /requireAutomationAuth\(request\)/);
assert.match(route, /export async function GET/);
assert.match(route, /readOnly: true/);
assert.doesNotMatch(route, /\.insert\(|\.upsert\(|\.update\(|\.delete\(/);

// Only approved, sale-ready product records can reach the avatar.
for (const gate of [
  /\.eq\("published", true\)/,
  /\.eq\("orderable", true\)/,
  /\.eq\("tracking_available", true\)/,
  /\.gt\("inventory", 0\)/,
  /\.is\("archived_at", null\)/,
  /\.not\("base_item_id", "is", null\)/,
  /\.eq\("base_publication_status", "published"\)/,
  /row\.base_publication_status === "published"/,
  /row\.productUrl !== null/,
]) assert.match(route, gate);

// Cap response size and avoid leaking sensitive commerce/supplier fields.
assert.match(route, /Math\.min\(20/);
assert.match(route, /Cache-Control.*no-store/);
for (const forbidden of [
  "source_cost",
  "shipping_cost",
  "contribution_profit",
  "supplier_product_id",
  "supplier_variant_id",
  "service_role_key",
  "tracking_number",
  "shop_orders",
]) assert.doesNotMatch(route, new RegExp(forbidden, "i"));

assert.match(route, /sellingPrice:/);
assert.match(route, /productUrl:/);
assert.match(route, /inStock: true/);
console.log("AI-live product feed safety contract: 21 assertions passed");
