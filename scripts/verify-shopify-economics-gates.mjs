import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const numberStart = source.indexOf("function asNumber(value: unknown): number | null");
const numberEnd = source.indexOf("\n}", numberStart);
const numberFn = numberStart >= 0 && numberEnd > numberStart ? source.slice(numberStart, numberEnd + 2) : "";
const gateStart = source.indexOf("function blockReasons(row: Listing): string[]");
const gateEnd = source.indexOf("export type ShopifySyncPreviewRow", gateStart);
const gate = gateStart >= 0 && gateEnd > gateStart ? source.slice(gateStart, gateEnd) : "";
const checks = [
  ["null, undefined, and blank strings are not numeric zero",
    numberFn.includes("if (typeof value !== \"string\" || !value.trim()) return null;")],
  ["invalid/non-finite numeric values are rejected",
    numberFn.includes("return Number.isFinite(n) ? n : null;")],
  ["unknown or negative shipping cost blocks Shopify sync",
    gate.includes("shippingCost === null || shippingCost < 0")],
  ["unknown or non-positive source cost blocks Shopify sync",
    gate.includes("sourceCost === null || sourceCost <= 0")],
  ["known zero shipping remains representable as free shipping",
    source.includes("asNumber(row.shipping_cost) === 0 ? \"送料無料\"")],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
if (failures.length) process.exit(1);
console.log(`Shopify economics regression checks: ${checks.length} passed`);
