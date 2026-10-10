import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
const listStart = source.indexOf("export async function listPublishedShopListings");
const slugStart = source.indexOf("export async function getShopListingBySlug");
const funnelStart = source.indexOf("export async function recordShopFunnelEvent");
const listBlock = source.slice(listStart, slugStart);
const slugBlock = source.slice(slugStart, funnelStart);
const checks = [
  ["catalog storefront filters rows through the canonical Sales Test Gate",
    listBlock.includes("hasPassedSalesTestGate(row as Parameters<typeof hasPassedSalesTestGate>[0])")],
  ["product detail returns null when the durable gate has been revoked",
    slugBlock.includes("!data || !hasPassedSalesTestGate(data as Parameters<typeof hasPassedSalesTestGate>[0])")],
  ["both storefront paths still enforce stock/orderability/tracking at query boundary",
    listBlock.includes('.eq("orderable", true)')
      && listBlock.includes('.gt("inventory", 0)')
      && listBlock.includes('.eq("tracking_available", true)')
      && slugBlock.includes('.eq("orderable", true)')
      && slugBlock.includes('.gt("inventory", 0)')
      && slugBlock.includes('.eq("tracking_available", true)')],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
if (failures.length) process.exit(1);
console.log(`Shopify storefront gate regression checks: ${checks.length} passed`);
