import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";

process.env.TRACER_TEST_MOCK_SUPABASE = "1";
process.env.CRON_SECRET = "test-secret";

const scenario = {
  recoveryError: null,
  claimError: null,
  ledgerError: null,
  observation: null,
  observationError: null,
};

function observation(overrides = {}) {
  return {
    itemCount: 4,
    inserted: 4,
    productsCreated: 1,
    canonicalVariantEvidenceParsed: 0,
    canonicalVariantEvidenceWritten: 0,
    canonicalVariantEvidenceWriteFailures: 0,
    skippedMarketplaces: [],
    enrichment: [],
    bestsellerIds: [],
    supplierCandidateIds: [],
    startIndex: 0,
    processedCount: 4,
    sourceIndex: 0,
    nextIndex: 4,
    hasMore: false,
    ...overrides,
  };
}

function cronDb() {
  const calls = [];
  function from(table) {
    const state = { table, op: "select", payload: null, filters: [] };
    const api = {
      select() { return api; },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      update(payload) { state.op = "update"; state.payload = payload; return api; },
      eq(column, value) { state.filters.push(["eq", column, value]); return api; },
      lt() { return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { return finish(); },
      single() { return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
    };
    function finish() {
      const call = { table: state.table, op: state.op, payload: state.payload, filters: state.filters.slice() };
      calls.push(call);
      const recoveryUpdate = state.op === "update" && state.filters.some((filter) => filter[1] === "status" && filter[2] === "running");
      if (recoveryUpdate) {
        return Promise.resolve(scenario.recoveryError ? { data: null, error: { message: scenario.recoveryError } } : { data: null, error: null });
      }
      if (state.op === "insert" && scenario.claimError) return Promise.resolve({ data: null, error: scenario.claimError });
      if (state.op === "insert") return Promise.resolve({ data: { id: "run-1" }, error: null });
      if (state.op === "update" && scenario.ledgerError) return Promise.resolve({ data: null, error: { message: scenario.ledgerError } });
      if (state.op === "select") return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    }
    return api;
  }
  return { calls, from };
}

let active = null;
mock.module("@/lib/supabase/admin", {
  exports: { createSupabaseAdminClient: () => active },
});
mock.module("@/lib/market/persist-bestsellers", {
  exports: {
    persistMarketplaceBestsellers: async () => {
      if (scenario.observationError) throw new Error(scenario.observationError);
      return scenario.observation;
    },
  },
});

const { executeMarketSourcingCron } = await import("../lib/ops/market-sourcing-cron.ts");
const { preservePrimaryFailure } = await import("../lib/ops/cron-lock.ts");
const { assessCountedCronResult } = await import("../lib/ops/publication-cron-report.ts");

function reset() {
  scenario.recoveryError = null;
  scenario.claimError = null;
  scenario.ledgerError = null;
  scenario.observation = observation();
  scenario.observationError = null;
  active = cronDb();
}

reset();
scenario.recoveryError = "stale lock update rejected";
const recoveryResponse = await executeMarketSourcingCron(active, 60);
const recoveryBody = recoveryResponse.body;
assert.equal(recoveryResponse.httpStatus, 500);
assert.equal(recoveryBody.ok, false);
assert.equal(recoveryBody.reason, "cron_lock_recovery_failed");
assert.equal(active.calls.some((call) => call.payload?.status === "succeeded"), false);
const recoveryLedger = active.calls.find((call) => call.op === "insert");
assert.equal(recoveryLedger.payload.status, "failed");
assert.equal(recoveryLedger.payload.metadata.reason, "cron_lock_recovery_failed");

reset();
scenario.claimError = { code: "23505", message: "duplicate running job" };
const runningResponse = await executeMarketSourcingCron(active, 60);
const runningBody = runningResponse.body;
assert.equal(runningResponse.httpStatus, 409);
assert.equal(runningBody.ok, false);
assert.equal(runningBody.reason, "cron_already_running");
assert.equal(active.calls.some((call) => call.payload?.status === "succeeded"), false);

reset();
scenario.claimError = { code: "42501", message: "permission denied" };
const claimResponse = await executeMarketSourcingCron(active, 60);
const claimBody = claimResponse.body;
assert.equal(claimResponse.httpStatus, 500);
assert.equal(claimBody.ok, false);
assert.equal(claimBody.reason, "cron_lock_claim_failed");

reset();
scenario.observation = observation({ inserted: 3, canonicalVariantEvidenceWriteFailures: 2 });
const partialResponse = await executeMarketSourcingCron(active, 60);
const partialBody = partialResponse.body;
assert.equal(partialResponse.httpStatus, 207);
assert.equal(partialBody.ok, false);
assert.equal(partialBody.cronStatus, "partial");
assert.equal(partialBody.failed, 2);
const partialLedger = active.calls.find((call) => call.op === "update" && call.payload?.metadata);
assert.equal(partialLedger.payload.status, "partial");
assert.equal(partialLedger.payload.failed, 2);

reset();
scenario.observation = observation({ inserted: 0, skippedMarketplaces: ["amazon.co.jp"] });
const skippedResponse = await executeMarketSourcingCron(active, 60);
const skippedBody = skippedResponse.body;
assert.equal(skippedResponse.httpStatus, 500);
assert.equal(skippedBody.ok, false);
assert.equal(skippedBody.cronStatus, "failed");
assert.equal(skippedBody.failed, 1);

reset();
scenario.ledgerError = "ledger write failed";
const ledgerResponse = await executeMarketSourcingCron(active, 60);
const ledgerBody = ledgerResponse.body;
assert.equal(ledgerResponse.httpStatus, 500);
assert.equal(ledgerBody.ok, false);
assert.equal(ledgerBody.reason, "cron_ledger_update_failed");
assert.equal(ledgerBody.ledgerUpdateFailed, true);
assert.equal(ledgerBody.cronStatus, "failed");

reset();
scenario.observationError = "marketplace source timed out";
scenario.ledgerError = "ledger write failed after the source error";
const thrownResponse = await executeMarketSourcingCron(active, 60);
const thrownBody = thrownResponse.body;
assert.equal(thrownResponse.httpStatus, 500);
assert.equal(thrownBody.ok, false);
assert.equal(thrownBody.error, "marketplace source timed out");
assert.equal(thrownBody.ledgerUpdateFailed, true);
assert.equal(thrownBody.reason, "market_sourcing_failed");

const preserved = await preservePrimaryFailure(
  async () => { throw new Error("primary failure"); },
  async () => { throw new Error("cleanup failure"); },
);
assert.equal(preserved.error instanceof Error ? preserved.error.message : "", "primary failure");
assert.equal(preserved.cleanupError instanceof Error ? preserved.cleanupError.message : "", "cleanup failure");
assert.equal(preserved.value, null);

const counted = assessCountedCronResult({ processed: 2, failed: 1 });
assert.equal(counted.ok, false);
assert.equal(counted.cronStatus, "partial");
assert.equal(counted.httpStatus, 207);
const clean = assessCountedCronResult({ processed: 2, failed: 0 });
assert.equal(clean.ok, true);
assert.equal(clean.cronStatus, "succeeded");

const attemptsMigration = readFileSync("supabase/migrations/20260929123000_create_supplier_order_attempts.sql", "utf8");
const cleanupMigration = readFileSync("supabase/migrations/20260929130000_cleanup_supplier_order_attempts_redundant_indexes.sql", "utf8");
const restoreMigration = readFileSync("supabase/migrations/20261012193000_supplier_order_attempt_duplicate_guard.sql", "utf8");
const purchaseOrders = readFileSync("supabase/migrations/20260921180000_tracer_ops_control.sql", "utf8");
for (const sql of [attemptsMigration, cleanupMigration, restoreMigration]) {
  assert.equal(/\bdelete\s+from\b/i.test(sql), false);
  assert.equal(/\btruncate\b/i.test(sql), false);
}
assert.match(attemptsMigration, /check \(state in \('in_progress','completed','unknown'\)\)/);
assert.match(purchaseOrders, /purchase_orders\(idempotency_key\)/);
assert.match(purchaseOrders, /where idempotency_key is not null/);
assert.match(restoreMigration, /raise exception/);
assert.match(restoreMigration, /supplier_order_attempts_idempotency_key_uq/);
assert.equal(/\bdrop\s+table\b/i.test(restoreMigration), false);

console.log("PASS cron failure propagation");
