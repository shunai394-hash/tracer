import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const checks = [
  ["existing BASE listings are gate-revalidated before catalog-copy generation",
    source.indexOf("Revalidate every already-visible BASE item before any translation or publish work.")
      >= 0
    && source.indexOf("Revalidate every already-visible BASE item before any translation or publish work.")
      < source.indexOf("const activeListings =")],
  ["gate-revoked listings are excluded from every later publication loop",
    source.includes("doNotRepublishIds.add(listingId)")
      && source.includes("if (doNotRepublishIds.has(listingId)) continue;")],
  ["new BASE items require the Sales Test Gate",
    source.includes("if (!hasSalesTestGate) {")
      && source.includes('error: "sales_test_gate_not_passed"')],
  ["BASE remote hide uses zero stock and explicit invisibility",
    source.includes("stock: 0,")
      && source.includes("visible: false,")],
  ["remote reconciliation errors are persisted and surfaced",
    source.includes('pipeline_reason: "sales_test_gate_hide_failed"')
      && source.includes("failed: results.filter((r) => r.failed === true || (!r.ok && !r.skipped)).length")
      && source.includes("failed: operationalFailure")],
  ["hidden/reconciled rows do not inflate the published count",
    source.includes("published: results.filter((r) => r.ok && Boolean(r.baseItemId) && !r.skipped).length")],
  ["durable Sales Test Gate is re-read immediately before visible BASE writes",
    source.includes("Re-read the durable gate immediately before any BASE create/edit with visible=true.")
      && source.indexOf("Re-read the durable gate immediately before any BASE create/edit with visible=true.")
        < source.indexOf("const created = await createBaseItem")],
  ["gate-read failures fail closed and are surfaced",
    source.includes("sales_test_gate_revalidation_read_failed")
      && source.includes("currentGateReadError")],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
if (failures.length) process.exit(1);
console.log(`BASE gate revalidation regression checks: ${checks.length} passed`);
