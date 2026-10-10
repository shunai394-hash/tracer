import assert from "node:assert/strict";
import {
  createPersistedLinkVerifier,
  createRetryQueueStore,
  finalizeInternalSupplyLinkRetry,
  isInternalLinkRetryDue,
  processInternalLinkCandidate,
  processInternalLinkCandidates,
} from "../lib/suppliers/internal-link-retry-lifecycle.ts";
import { internalLinkRetryDelayMs, selectDueInternalLinkRetryIds } from "../lib/suppliers/cj-identity-reverify-policy.ts";

// The application code under test is the real candidate lifecycle plus its
// real Supabase adapters (retry queue store, read-back verifier). Only the
// database is replaced, by an in-memory table set that honours the same
// query-builder calls and can inject write/read failures. No network or
// production database is touched.

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS", name);
  } catch (error) {
    failed += 1;
    console.error("FAIL", name, error);
  }
}

function memoryDb() {
  const tables = new Map();
  const failures = [];
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const failure = (name, op) => {
    const index = failures.findIndex((f) => f.table === name && f.op === op);
    if (index === -1) return null;
    const [f] = failures.splice(index, 1);
    return { message: f.message };
  };
  const db = {
    tables,
    failNext(tableName, op, message = `${op} failed`) { failures.push({ table: tableName, op, message }); },
    rows(name) { return [...table(name).values()]; },
    from(name) {
      return {
        upsert: async (row, options) => {
          const error = failure(name, "upsert");
          if (error) return { data: null, error };
          const key = String(row[options.onConflict]);
          table(name).set(key, { ...(table(name).get(key) ?? {}), ...row });
          return { data: null, error: null };
        },
        delete: () => ({
          eq: async (column, value) => {
            const error = failure(name, "delete");
            if (error) return { data: null, error };
            for (const [key, row] of table(name)) if (String(row[column]) === String(value)) table(name).delete(key);
            return { data: null, error: null };
          },
        }),
        select: () => ({
          eq: (column, value) => ({
            maybeSingle: async () => {
              const error = failure(name, "select");
              if (error) return { data: null, error };
              const row = [...table(name).values()].find((r) => String(r[column]) === String(value)) ?? null;
              return { data: row, error: null };
            },
          }),
        }),
      };
    },
  };
  return db;
}

const NOW = new Date("2026-10-10T04:00:00.000Z");
const QUEUE = "internal_supply_link_retry_queue";

function harness({ bestsellers = {}, link, sync, db = memoryDb(), timeoutMs } = {}) {
  const calls = { sync: 0 };
  const deps = {
    loadBestseller: async (id) => bestsellers[id] ?? null,
    linkInternalSupply: link ?? (async (b) => ({ matched: true, supplierListingId: `L-${b.id}`, supplyVariantId: `V-${b.id}`, linkStatus: "verified", reason: "canonical_link_saved" })),
    syncCatalog: async (args) => {
      calls.sync += 1;
      return sync(args, db);
    },
    verifyPersistedLink: createPersistedLinkVerifier(db),
    retryQueue: createRetryQueueStore(db),
    priorRetryCount: (id) => Number(db.tables.get(QUEUE)?.get(id)?.retry_count ?? 0),
    now: () => NOW,
    syncTimeoutMs: timeoutMs,
  };
  return { db, deps, calls };
}

// A sync that commits the catalog variant the way the RPC does.
function committingSync({ bestsellerId, supplyVariantId }, db) {
  const catalogId = `C-${bestsellerId}`;
  const variantId = `CV-${bestsellerId}`;
  db.from("tracer_supply_variants").upsert({ id: variantId, catalog_id: catalogId, internal_supply_variant_id: supplyVariantId }, { onConflict: "id" });
  return { matched: true, catalogId, variantId, reason: "ready" };
}

const seedRetry = (db, id, count) => db.from(QUEUE).upsert({ bestseller_id: id, reason: "catalog_sync_failed", retry_count: count, next_attempt_at: NOW.toISOString() }, { onConflict: "bestseller_id" });

await run("success: retry deleted only after the persisted link is read back", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: committingSync });
  await seedRetry(db, "b1", 2);
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "linked");
  assert.equal(outcome.catalog.catalogId, "C-b1");
  assert.equal(db.tables.get(QUEUE).has("b1"), false);
});

await run("success reported by sync but persisted row points elsewhere: retry kept", async () => {
  const { db, deps } = harness({
    bestsellers: { b1: { id: "b1" } },
    sync: ({ bestsellerId }, d) => {
      d.from("tracer_supply_variants").upsert({ id: `CV-${bestsellerId}`, catalog_id: `C-${bestsellerId}`, internal_supply_variant_id: "OTHER" }, { onConflict: "id" });
      return { matched: true, catalogId: `C-${bestsellerId}`, variantId: `CV-${bestsellerId}` };
    },
  });
  await seedRetry(db, "b1", 1);
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "catalog_sync_retry");
  assert.equal(outcome.kind, "unverified");
  const row = db.tables.get(QUEUE).get("b1");
  assert.equal(row.link_status, "catalog_link_unverified");
  assert.equal(row.retry_count, 2);
});

await run("sync matched:false keeps retry with reason, candidate ids, attempt and next time", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: () => ({ matched: false, reason: "variant_scope_incomplete_or_cross_product" }) });
  await seedRetry(db, "b1", 1);
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "catalog_sync_retry");
  assert.equal(outcome.kind, "rejected");
  const row = db.tables.get(QUEUE).get("b1");
  assert.equal(row.reason, "catalog_sync_failed");
  assert.equal(row.link_status, "catalog_sync_rejected");
  assert.equal(row.last_error, "variant_scope_incomplete_or_cross_product");
  assert.equal(row.supplier_listing_id, "L-b1");
  assert.equal(row.supply_variant_id, "V-b1");
  assert.equal(row.retry_count, 2);
  assert.equal(row.next_attempt_at, new Date(NOW.getTime() + internalLinkRetryDelayMs(2)).toISOString());
});

await run("sync exception keeps retry as a retryable catalog_sync_error", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: () => { throw new Error("commit_internal_supply_catalog_sync: deadlock"); } });
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "catalog_sync_retry");
  assert.equal(outcome.kind, "exception");
  const row = db.tables.get(QUEUE).get("b1");
  assert.equal(row.link_status, "catalog_sync_error");
  assert.match(row.last_error, /deadlock/);
  assert.equal(row.retry_count, 1);
});

await run("sync timeout keeps retry as a retryable catalog_sync_error", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: () => new Promise(() => {}), timeoutMs: 20 });
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "catalog_sync_retry");
  assert.equal(outcome.kind, "exception");
  assert.match(db.tables.get(QUEUE).get("b1").last_error, /catalog_sync_timeout_after_20ms/);
});

await run("retry delete failure is surfaced, row survives, rerun recovers and deletes", async () => {
  const { db, deps, calls } = harness({ bestsellers: { b1: { id: "b1" } }, sync: committingSync });
  await seedRetry(db, "b1", 3);
  db.failNext(QUEUE, "delete", "permission denied");
  const first = await processInternalLinkCandidate("b1", deps);
  assert.equal(first.status, "retry_cleanup_failed");
  assert.match(first.error, /retry queue cleanup failed for b1: permission denied/);
  assert.equal(db.tables.get(QUEUE).has("b1"), true);
  assert.deepEqual(selectDueInternalLinkRetryIds([{ bestseller_id: "b1", next_attempt_at: db.tables.get(QUEUE).get("b1").next_attempt_at }], NOW.getTime()), ["b1"]);
  const second = await processInternalLinkCandidate("b1", deps);
  assert.equal(second.status, "linked");
  assert.equal(db.tables.get(QUEUE).has("b1"), false);
  assert.equal(calls.sync, 2);
});

await run("read-back failure keeps retry (verification error is not success)", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: committingSync });
  db.failNext("tracer_supply_variants", "select", "statement timeout");
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "catalog_sync_retry");
  assert.equal(outcome.kind, "unverified");
  assert.match(db.tables.get(QUEUE).get("b1").last_error, /statement timeout/);
});

await run("link not matched persists link reason with backoff", async () => {
  const { db, deps, calls } = harness({
    bestsellers: { b1: { id: "b1" } },
    link: async () => ({ matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "lookup_failed", reason: "lookup_failed" }),
    sync: committingSync,
  });
  const outcome = await processInternalLinkCandidate("b1", deps);
  assert.equal(outcome.status, "link_not_matched");
  assert.equal(calls.sync, 0);
  const row = db.tables.get(QUEUE).get("b1");
  assert.equal(row.reason, "lookup_failed");
  assert.equal(row.last_error, "Supplier identity lookup failed; see cron telemetry");
});

await run("same candidate re-run increments attempt and backs off exponentially", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: () => ({ matched: false, reason: "atomic_catalog_sync_rejected" }) });
  await processInternalLinkCandidate("b1", deps);
  const firstDue = Date.parse(db.tables.get(QUEUE).get("b1").next_attempt_at);
  await processInternalLinkCandidate("b1", deps);
  const row = db.tables.get(QUEUE).get("b1");
  assert.equal(row.retry_count, 2);
  assert.equal(firstDue - NOW.getTime(), internalLinkRetryDelayMs(1));
  assert.equal(Date.parse(row.next_attempt_at) - NOW.getTime(), internalLinkRetryDelayMs(2));
  assert.ok(internalLinkRetryDelayMs(2) > internalLinkRetryDelayMs(1));
});

await run("duplicate concurrent runs on success converge (no residual retry)", async () => {
  const { db, deps, calls } = harness({ bestsellers: { b1: { id: "b1" } }, sync: committingSync });
  await seedRetry(db, "b1", 1);
  const [a, b] = await Promise.all([processInternalLinkCandidate("b1", deps), processInternalLinkCandidate("b1", deps)]);
  assert.equal(a.status, "linked");
  assert.equal(b.status, "linked");
  assert.equal(calls.sync, 2);
  assert.equal(db.tables.get(QUEUE).has("b1"), false);
});

await run("partial success batch continues past failures; queue holds only unfinished work", async () => {
  const { db, deps } = harness({
    bestsellers: { ok: { id: "ok" }, rejected: { id: "rejected" }, persistFail: { id: "persistFail" }, after: { id: "after" } },
    sync: (args, d) => (args.bestsellerId === "rejected" || args.bestsellerId === "persistFail"
      ? { matched: false, reason: "requested_variant_not_active_orderable_or_in_stock" }
      : committingSync(args, d)),
  });
  // persistFail: its retry write fails -> durability lost -> candidate_error, batch continues.
  const store = deps.retryQueue;
  deps.retryQueue = {
    upsert: async (row) => { if (row.bestseller_id === "persistFail") db.failNext(QUEUE, "upsert", "disk full"); return store.upsert(row); },
    remove: store.remove,
  };
  const outcomes = await processInternalLinkCandidates(["ok", "rejected", "persistFail", "missing", "after"], deps);
  assert.deepEqual(outcomes.map((o) => [o.candidateId, o.status]), [
    ["ok", "linked"],
    ["rejected", "catalog_sync_retry"],
    ["persistFail", "candidate_error"],
    ["missing", "not_found"],
    ["after", "linked"],
  ]);
  assert.match(outcomes[2].error, /retry persistence failed for persistFail: disk full/);
  assert.deepEqual([...db.tables.get(QUEUE).keys()], ["rejected"]);
});

await run("next sweep re-selects a retained retry only once it is due", async () => {
  const { db, deps } = harness({ bestsellers: { b1: { id: "b1" } }, sync: () => ({ matched: false, reason: "generation_missing" }) });
  await processInternalLinkCandidate("b1", deps);
  const rows = db.rows(QUEUE).map((r) => ({ bestseller_id: r.bestseller_id, next_attempt_at: r.next_attempt_at }));
  const dueAt = Date.parse(rows[0].next_attempt_at);
  assert.deepEqual(selectDueInternalLinkRetryIds(rows, dueAt - 1), []);
  assert.deepEqual(selectDueInternalLinkRetryIds(rows, dueAt), ["b1"]);
  // Postgres returns "+00:00" offsets; due checks compare instants, not strings.
  assert.equal(isInternalLinkRetryDue("2026-10-10T04:00:00.123456+00:00", Date.parse("2026-10-10T04:00:00.200Z")), true);
  assert.equal(isInternalLinkRetryDue("2026-10-10T04:00:01+00:00", Date.parse("2026-10-10T04:00:00.999Z")), false);
  assert.equal(isInternalLinkRetryDue("not-a-date", NOW.getTime()), false);
  assert.equal(isInternalLinkRetryDue(null, NOW.getTime()), true);
});

await run("finalize never clears the retry when failure persistence throws", async () => {
  const events = [];
  await assert.rejects(() => finalizeInternalSupplyLinkRetry({
    syncCatalog: async () => ({ matched: false, reason: "x" }),
    persistFailure: async () => { events.push("persist"); throw new Error("write failed"); },
    clearRetry: async () => { events.push("clear"); },
  }), /write failed/);
  assert.deepEqual(events, ["persist"]);
});

console.log(`Application retry lifecycle tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
