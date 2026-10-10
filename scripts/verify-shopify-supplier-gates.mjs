import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const start = source.indexOf("function blockReasons(row: Listing): string[]");
const end = source.indexOf("export type ShopifySyncPreviewRow", start);
const gate = start >= 0 && end > start ? source.slice(start, end) : "";
const checks = [
  ["Shopify allows only explicitly registered CJ supplier names",
    gate.includes('!/^(cj|cjdropshipping)$/i.test(String(row.supplier_name ?? "").trim())')],
  ["Shopify requires a concrete supplier product ID",
    gate.includes('if (!String(row.supplier_product_id ?? "").trim()) reasons.push("supplier_product_missing")')],
  ["Shopify requires a concrete supplier variant ID",
    gate.includes('if (!String(row.supplier_variant_id ?? "").trim()) reasons.push("supplier_variant_missing")')],
  ["sync and preview share the same supplier identity gate",
    source.includes("const reasons = blockReasons(row);")
      && !source.includes('if (!row.supplier_variant_id) reasons.push("supplier_variant_missing")')],
  ["considered count includes blocked and eligible rows",
    source.includes("considered: rows.length,")],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
if (failures.length) process.exit(1);
console.log(`Shopify supplier-gate regression checks: ${checks.length} passed`);
