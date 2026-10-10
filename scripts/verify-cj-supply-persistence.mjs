import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync("lib/intelligence/persist-cj-supply-intelligence.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const canonicalProductId = "canonical-product-1";
const listingId = "supplier-listing-1";
const supplierVariantId = "cj-variant-1";
const barcode = "4006381333931";
const identityEvidence = {
  id: "evidence-1",
  bestseller_id: "bestseller-1",
  source_variant_id: "market-variant-1",
  jan: barcode,
  gtin: barcode,
  ean: null,
  upc: null,
  mpn: null,
  title: "Canonical Child Variant",
  fetched_at: "2026-10-10T00:00:00.000Z",
};
const canonicalParent = { id: "bestseller-1", product_id: canonicalProductId, brand: "Example", title: "Canonical Parent" };

class FakeQuery {
  constructor(db, table) {
    this.db = db; this.table = table; this.action = "select"; this.payload = null;
    this.filters = []; this.orClause = ""; this.returning = false; this.limitCount = null;
  }
  select() { this.returning = true; return this; }
  eq(key, value) { this.filters.push((row) => row?.[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row?.[key])); return this; }
  or(value) { this.orClause = value; return this; }
  limit(value) { this.limitCount = value; return this; }
  order() { return this; }
  update(payload) { this.action = "update"; this.payload = payload; return this; }
  insert(payload) { this.action = "insert"; this.payload = payload; return this; }
  upsert(payload) { this.action = "upsert"; this.payload = payload; return this; }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }
  async execute(single) {
    const rows = this.db.tables[this.table] ?? [];
    if (this.action === "update") {
      if (this.db.failUpdateTable === this.table) return { data: null, error: { message: "injected update failure" } };
      const matched = rows.filter((row) => this.filters.every((test) => test(row)));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: this.returning ? matched : null, error: null };
    }
    if (this.action === "insert" || this.action === "upsert") {
      if (this.db.failWriteTable === this.table) return { data: null, error: { message: "injected write failure" } };
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = items.map((item) => ({ id: item.id ?? `${this.table}-${this.db.sequence++}`, ...item }));
      for (const item of inserted) {
        if (this.action === "upsert" && this.table === "product_intelligence") {
          const oldIndex = rows.findIndex((row) => row.product_id === item.product_id);
          if (oldIndex >= 0) rows[oldIndex] = { ...rows[oldIndex], ...item }; else rows.push(item);
        } else rows.push(item);
      }
      return { data: single ? inserted[0] : inserted, error: null };
    }
    let selected = rows.filter((row) => this.filters.every((test) => test(row)));
    if (this.table === "marketplace_bestseller_variants" && this.orClause) {
      const terms = this.orClause.split(",").map((term) => { const match = term.match(/^([a-z_]+)\.eq\.(.*)$/); return match ? { field: match[1], value: match[2] } : null; }).filter(Boolean);
      selected = selected.filter((row) => terms.some(({ field, value }) => String(row[field] ?? "") === value));
    }
    if (this.limitCount !== null) selected = selected.slice(0, this.limitCount);
    if (single) return { data: selected[0] ?? null, error: null };
    return { data: selected, error: null, count: selected.length };
  }
}
class FakeDb {
  constructor({ identityRows = [identityEvidence], failUpdateTable = null, failWriteTable = null } = {}) {
    this.sequence = 1; this.variantBarcodeFilter = barcode; this.failUpdateTable = failUpdateTable; this.failWriteTable = failWriteTable;
    this.tables = {
      supplier_listings: [{ id: listingId, metadata: { prior: true }, product_id: "stale-product", bestseller_id: "stale-bestseller", orderable: true, api_available: true, tracking_available: true }],
      marketplace_bestseller_variants: identityRows,
      marketplace_bestsellers: [canonicalParent],
      product_offers: [],
      product_intelligence: [],
    };
  }
  from(table) { return new FakeQuery(this, table); }
}

function compileRealTsModule(path) {
  const code = fs.readFileSync(path, "utf8");
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const moduleRecord = { exports: {} };
  vm.runInNewContext(output, {
    module: moduleRecord,
    exports: moduleRecord.exports,
    require: (id) => { throw new Error(`Unexpected import in real helper ${path}: ${id}`); },
    console, Date, Set, Map, Object, Number, String, Array, Math, Error, JSON, RegExp,
  }, { filename: path + ".compiled.cjs" });
  return moduleRecord.exports;
}

const realIdentifiers = compileRealTsModule("lib/market/identifiers.ts");
const realVariantBarcodeProof = compileRealTsModule("lib/market/variant-barcode-proof.ts");
const realCjIdentityPolicy = compileRealTsModule("lib/suppliers/cj-identity-reverify-policy.ts");

const modules = {
  "server-only": {},
  "@/lib/intelligence/currency-confidence": { assessCurrencyConfidence: () => ({ confidence: "high", reasons: [] }) },
  "@/lib/supabase/admin": { createSupabaseAdminClient: () => { throw new Error("test must inject a disposable DB"); } },
  "@/lib/sources/cj": {
    fetchCJProductVariants: async () => [{ vid: supplierVariantId, barcode }],
    fetchCJVariantByVid: async (vid) => ({ vid, barcode }),
  },
  "@/lib/market/identifiers": realIdentifiers,
  "@/lib/market/variant-barcode-proof": realVariantBarcodeProof,
  "@/lib/suppliers/cj-identity-reverify-policy": realCjIdentityPolicy,
};
const testModule = { exports: {} };
const context = {
  module: testModule, exports: testModule.exports,
  require: (id) => {
    if (!(id in modules)) throw new Error(`Unexpected import in persistence test: ${id}`);
    return modules[id];
  },
  console, Date, Set, Map, Object, Number, String, Array, Math, Error, JSON,
};
vm.runInNewContext(js, context, { filename: "persist-cj-supply-intelligence.compiled.cjs" });
const { persistCjSupplyIntelligence } = testModule.exports;

const args = {
  productId: "caller-fallback-must-not-be-linked",
  title: "CJ candidate",
  imageUrl: "https://example.invalid/product.jpg",
  cost: 2.5,
  shippingCost: 1,
  supplierListingId: listingId,
  supplierProductId: "cj-product-1",
  supplierVariantId,
  inventory: 25,
  query: "ci-fixture",
  fxRate: 150,
  sellingPriceJpy: 1980,
  variantBarcode: "stale-parent-barcode-must-not-be-trusted",
};

{
  const db = new FakeDb();
  const result = await persistCjSupplyIntelligence(args, { db, now: () => new Date("2026-10-10T00:00:00.000Z"), fetchProductVariants: async () => [{ vid: supplierVariantId, barcode }], fetchVariantByVid: async (vid) => ({ vid, barcode }) });
  assert.equal(result.identity?.productId, canonicalProductId, "real resolver must choose the exact canonical child variant");
  assert.equal(result.identity?.marketplaceVariantEvidenceId, "evidence-1");
  assert.equal(result.offerId !== null, true);
  assert.equal(result.intelligenceId !== null, true);
  const listing = db.tables.supplier_listings[0];
  assert.equal(listing.product_id, canonicalProductId);
  assert.equal(listing.bestseller_id, "bestseller-1");
  assert.equal(listing.metadata.marketplace_variant_evidence_id, "evidence-1");
  assert.equal(listing.metadata.marketplace_source_variant_id, "market-variant-1");
  assert.equal(listing.orderable, false);
  assert.equal(listing.api_available, false);
  assert.equal(listing.tracking_available, false);
  assert.equal(db.tables.product_offers[0].product_id, canonicalProductId);
  assert.equal(db.tables.product_intelligence[0].product_id, canonicalProductId);
}

{
  const duplicateEvidence = [
    identityEvidence,
    { ...identityEvidence, id: "evidence-2", source_variant_id: "market-variant-2" },
  ];
  const db = new FakeDb({ identityRows: duplicateEvidence });
  const result = await persistCjSupplyIntelligence(args, { db, fetchProductVariants: async () => [{ vid: supplierVariantId, barcode }], fetchVariantByVid: async (vid) => ({ vid, barcode }) });
  assert.equal(result.identity, null, "duplicate child evidence must be rejected");
  assert.equal(result.offerId, null);
  assert.equal(result.intelligenceId, null);
  const listing = db.tables.supplier_listings[0];
  assert.equal(listing.product_id, null, "stale canonical link must be cleared");
  assert.equal(listing.bestseller_id, null);
  assert.equal(listing.identity_status, "unverified");
  assert.equal(listing.orderable, false);
  assert.equal(listing.api_available, false);
  assert.equal(listing.tracking_available, false);
  assert.equal(db.tables.product_offers.length, 0, "ambiguous identity must not create a canonical offer");
  assert.equal(db.tables.product_intelligence.length, 0, "ambiguous identity must not create canonical intelligence");
}

{
  const db = new FakeDb();
  const result = await persistCjSupplyIntelligence(args, { db, fetchProductVariants: async () => [{ vid: "different-cj-variant", barcode }], fetchVariantByVid: async (vid) => ({ vid: "different-cj-variant", barcode }) });
  assert.equal(result.identity, null, "barcode from a mismatched CJ variant ID must not link");
  assert.equal(db.tables.supplier_listings[0].product_id, null);
  assert.equal(db.tables.product_offers.length, 0);
  assert.equal(db.tables.product_intelligence.length, 0);
}

{
  const db = new FakeDb();
  const result = await persistCjSupplyIntelligence(args, { db, fetchProductVariants: async () => [{ vid: supplierVariantId, barcode: "  " }], fetchVariantByVid: async (vid) => ({ vid, barcode: "  " }) });
  assert.equal(result.identity, null, "blank barcode must not link");
  assert.equal(db.tables.supplier_listings[0].product_id, null);
  assert.equal(db.tables.product_offers.length, 0);
  assert.equal(db.tables.product_intelligence.length, 0);
}

{
  const db = new FakeDb({ failUpdateTable: "supplier_listings" });
  await assert.rejects(() => persistCjSupplyIntelligence(args, { db, identity: null }), /supplier evidence persistence failed/);
  assert.equal(db.tables.product_offers.length, 0, "failed listing write must not continue to offer persistence");
  assert.equal(db.tables.product_intelligence.length, 0, "failed listing write must not continue to intelligence persistence");
}

console.log("PASS: actual persistence function + identity resolver; exact unique match; duplicate/mismatched/blank barcode rejected; stale link cleared; procurement flags remain false; no canonical writes on no-match; failed listing write halts downstream writes.");
