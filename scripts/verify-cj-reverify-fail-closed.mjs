import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync("lib/suppliers/clear-cj-identity-link.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

class FakeQuery {
  constructor(db) { this.db = db; this.action = "select"; this.filters = []; this.payload = null; }
  select() { this.action = "select"; return this; }
  eq(key, value) { this.filters.push((row) => row?.[key] === value); return this; }
  maybeSingle() { return Promise.resolve({ data: this.db.rows.find((row) => this.filters.every((test) => test(row))) ?? null, error: null }); }
  update(payload) { this.action = "update"; this.payload = payload; return this; }
  then(resolve, reject) {
    if (this.db.failUpdate) return Promise.resolve({ data: null, error: { message: "injected reset failure" } }).then(resolve, reject);
    const matched = this.db.rows.filter((row) => this.filters.every((test) => test(row)));
    for (const row of matched) Object.assign(row, this.payload);
    return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
  }
}
class FakeDb {
  constructor() {
    this.failUpdate = false;
    this.rows = [{
      id: "listing-1", bestseller_id: "stale-bestseller", product_id: "stale-product",
      identity_method: "gtin", identity_status: "linked", identity_confidence: 0.99,
      orderable: true, api_available: true, tracking_available: true, verification_status: "verified",
      metadata: { marketplace_variant_evidence_id: "stale-evidence", marketplace_source_variant_id: "stale-source-variant", variant_barcode: "1234567890123", keep_audit: "yes" },
    }];
  }
  from(table) { assert.equal(table, "supplier_listings"); return new FakeQuery(this); }
}
const moduleRecord = { exports: {} };
vm.runInNewContext(js, {
  module: moduleRecord, exports: moduleRecord.exports,
  require: (id) => {
    if (id === "server-only") return {};
    if (id === "@/lib/supabase/admin") return { createSupabaseAdminClient: () => { throw new Error("test must inject disposable DB"); } };
    throw new Error("unexpected import " + id);
  },
  console, Date, Set, Map, Object, Number, String, Array, Math, Error, JSON, RegExp,
}, { filename: "clear-cj-identity-link.compiled.cjs" });
const { clearCjIdentityLinkOnFailure } = moduleRecord.exports;
const now = new Date("2026-10-10T00:00:00.000Z");
const audit = { variant_barcode_raw: null, variant_barcode_validation: "missing" };

{
  const db = new FakeDb();
  await clearCjIdentityLinkOnFailure(db, "listing-1", {}, { reason: "no_unique_marketplace_identifier_match", retryDelayMs: 7 * 24 * 60 * 60 * 1000, checkedAt: now, variantBarcode: null, barcodeAudit: audit });
  const row = db.rows[0];
  assert.equal(row.product_id, null);
  assert.equal(row.bestseller_id, null);
  assert.equal(row.identity_method, "supply_discovered");
  assert.equal(row.identity_status, "unverified");
  assert.equal(row.identity_confidence, 0);
  assert.equal(row.orderable, false);
  assert.equal(row.api_available, false);
  assert.equal(row.tracking_available, false);
  assert.equal(row.verification_status, "retryable");
  assert.equal(row.metadata.marketplace_variant_evidence_id, null);
  assert.equal(row.metadata.marketplace_source_variant_id, null);
  assert.equal(row.metadata.variant_barcode, null);
  assert.equal(row.metadata.variant_barcode_raw, null);
  assert.equal(row.metadata.identity_hold_reason, "no_unique_marketplace_identifier_match");
  assert.equal(row.metadata.keep_audit, "yes");
  assert.equal(row.metadata.next_identity_reverify_at, "2026-10-17T00:00:00.000Z");
}

{
  const db = new FakeDb();
  db.failUpdate = true;
  await assert.rejects(
    () => clearCjIdentityLinkOnFailure(db, "listing-1", {}, { reason: "reverify_error", retryDelayMs: 60 * 60 * 1000, checkedAt: now, variantBarcode: null, barcodeAudit: audit }),
    /CJ identity reset failed: injected reset failure/,
  );
}

// Guard the production reverify control flow as well as the helper contract.
const reverifySource = fs.readFileSync("lib/suppliers/reverify-cj-identity.ts", "utf8");
assert.match(reverifySource, /if\s*\(!identity\)\s*\{[\s\S]*?clearCjIdentityLinkOnFailure/);
assert.match(reverifySource, /reason:\s*"missing_economics_or_image"[\s\S]*?clearCjIdentityLinkOnFailure/);
assert.match(reverifySource, /reason:\s*"reverify_error"[\s\S]*?clearCjIdentityLinkOnFailure/);
assert.doesNotMatch(reverifySource, /identity\?\.productId\s*\?\?\s*String\(row\.product_id\)/);

console.log("PASS: actual fail-closed reset helper and reverify control-flow guards clears stale canonical/evidence links and all order/tracking flags; preserves unrelated audit metadata; schedules retry; surfaces DB write failures.");
