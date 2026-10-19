import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.match(source, /reason: "legacy_shop_listings_disabled_canonical_commerce_only"/,
  "legacy supplier rows must not create new BASE-only listings");
assert.doesNotMatch(source, /selectAndPublishSupplySalesTests\(/,
  "patrol-ai must not use the legacy selector to create listings outside the canonical commerce catalog");
const patrolRoute = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
assert.doesNotMatch(patrolRoute, /publishPublishedListingsToBase\(/,
  "patrol-ai must not publish legacy shop_listings directly to BASE");
assert.match(source, /optionalDiscoverySteps = new Set\(\["bestsellers", "auxiliary_trends", "supply", "supply_first", "dropship"\]\)/,
  "retryable source discovery/cooldown stages must not block processing of persisted supply candidates");
assert.match(source, /optionalDiscoverySteps\.has\(step\.name\) && step\.retryable === true\) return false/,
  "only retryable skips in optional discovery stages are non-blocking");
assert.match(source, /const incomplete = pipelineTimedOut \|\| Boolean\(deferredStep\)/,
  "real core timeouts and deferred required stages must still fail completion");
for (const required of ["match", "supply_sales_test_select", "sales_test_select", "ordering", "test_ready"]) {
  assert.doesNotMatch(source, new RegExp('optionalDiscoverySteps = new Set\\(\\[[^\\]]*"' + required + '"'),
    required + " must remain a core pipeline stage");
}
assert.match(source, /dedicated_commerce_cj_import_cron_owns_live_cj_discovery/,
  "the five-minute patrol must leave live CJ discovery to its scheduled canonical importer");
assert.match(source, /discoveryCron: "\/api\/cron\/commerce-cj-import"/);
assert.doesNotMatch(source, /discoverAndCreateCjSupply\(/,
  "the five-minute patrol must not duplicate live CJ API discovery calls");
assert.ok(source.indexOf("const supplyFirstStep") < source.indexOf("marketplace_sourcing_disabled_supplier_native_only"),
  "the supplier-native supply-first stage remains visible before the disabled marketplace stage");
assert.doesNotMatch(source, /verifiedSupplyPages|verifiedSupplyOffset|const supplyCandidateIds/,
  "legacy supplier rows must not be selected for direct channel publication");

const cronRoute = await readFile(new URL("../app/api/cron/supply-first/route.ts", import.meta.url), "utf8");
const recoveryWorkflow = await readFile(new URL("../.github/workflows/tracer-one-shot-supply-recovery.yml", import.meta.url), "utf8");
assert.match(recoveryWorkflow, /supply-first\.json/);
assert.match(recoveryWorkflow, /supplierListingId/);
assert.match(recoveryWorkflow, /api\/cron\/cj-sandbox-order-test/);
assert.doesNotMatch(recoveryWorkflow, /SUPPLIER_LISTING_ID="83eb3a0e-eced-4041-afa5-da57c3084f4c"/,
  "sandbox recovery must not depend on a supplier listing ID from the pre-reset database");
assert.match(recoveryWorkflow, /sandbox_failed/);
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
assert.match(cronRoute, /const DISCOVERY_BUDGET_MS = 75_000/,
  "supplier discovery must be bounded so opportunity intelligence and channel publication have remaining route time");
assert.match(cronRoute, /const DISCOVERY_BATCH_SIZE = 4/,
  "supplier discovery must use a small bounded batch that can finish before the route deadline");
const discovery = await readFile(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
assert.match(discovery, /MAX_CATALOG_SEARCH_PAGES_PER_RUN = 5/,
  "catalog cursor must advance after a bounded number of search pages instead of scanning all queries until timeout");
assert.match(cronRoute, /const discoveryIncomplete/);
assert.match(cronRoute, /status: runStatus/);
assert.match(cronRoute, /status: discoveryIncomplete \? 503 : 200/);
assert.ok(cronRoute.includes("supply_first_already_running"));
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/commerce-cj-import").map((job) => job.schedule), ["0,30 * * * *"]);
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/supply-first"), [],
  "legacy supply-first must not be scheduled beside the canonical commerce importer");
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/patrol-ai").map((job) => job.schedule), ["*/5 * * * *"],
  "the existing five-minute patrol must remain enabled");

console.log("Supply-first core completion: optional discovery cooldowns do not block the core cycle; empty deadline runs are deferred");
