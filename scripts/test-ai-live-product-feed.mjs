import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(
  new URL("../app/api/admin/ai-live/products/route.ts", import.meta.url),
  "utf8",
);

assert.match(route, /requireAutomationAuth\(request\)/);
assert.match(route, /authorizedWorkerToken\(request\)/);
assert.match(route, /AI_LIVE_WORKER_TOKEN/);
assert.match(route, /timingSafeEqual/);
assert.match(route, /export async function GET/);
assert.match(route, /readOnly: true/);
assert.doesNotMatch(route, /\.insert\(|\.upsert\(|\.update\(|\.delete\(/);

for (const gate of [
  "getPublishableSupplierListingStatuses",
  "supplier_listing_id",
  "supplier_product_id",
  "supplier_variant_id",
  "identityStatuses.get(listingId)",
  'verification_status !== "verified"',
  'shipping_status !== "verified"',
  "configured !== true",
  "price_confirmed !== true",
  "inventory_confirmed !== true",
  "api_available !== true",
  "orderable !== true",
  "tracking_available !== true",
  "ship_to",
  "supplier.shipping_cost === null",
  "Number.isFinite(Number(supplier.shipping_cost))",
  "Number.isFinite(Number(supplier.cost))",
  "Number.isFinite(Number(supplier.inventory))",
  "isFreshVerifiedAt(supplier.last_verified_at, now)",
  "MAX_SUPPLIER_FACT_AGE_MS",
  "contribution_profit",
  "factsVersion:",
  "factsVerifiedAt:",
  "scriptText:",
]) assert.ok(route.includes(gate), `missing eligibility gate: ${gate}`);

for (const gate of [
  '.eq("published", true)',
  '.eq("orderable", true)',
  '.eq("tracking_available", true)',
  '.gt("inventory", 0)',
  '.gt("selling_price", 0)',
  '.gt("source_cost", 0)',
  '.gte("shipping_cost", 0)',
  '.gt("contribution_profit", 0)',
  '.is("archived_at", null)',
  '.eq("base_publication_status", "published")',
]) assert.ok(route.includes(gate), `missing listing gate: ${gate}`);

assert.match(route, /Math\.min\(20/);
assert.ok(route.includes('Cache-Control: "no-store"'));
assert.ok(route.includes("sellingPrice:"));
assert.ok(route.includes("productUrl"));
assert.ok(route.includes("inStock: true"));

const serializationStart = route.indexOf("return [{");
const serializationEnd = route.indexOf("}];", serializationStart);
assert.ok(serializationStart >= 0 && serializationEnd > serializationStart);
const serialized = route.slice(serializationStart, serializationEnd);
for (const forbidden of [
  "source_cost", "shipping_cost", "contribution_profit",
  "supplier_product_id", "supplier_variant_id",
  "service_role_key", "tracking_number", "shop_orders",
]) assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));

console.log("AI-live product feed safety contract: all assertions passed");
