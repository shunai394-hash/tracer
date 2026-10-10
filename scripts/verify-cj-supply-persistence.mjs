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
      const inserted = items.map((item, index) => ({ id: item.id ?? `${this.table}-${this.db.sequence++}`, ...item }));
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
      const expected = this.db.variantBarcodeFilter;
      selected = selected.filter((row) => [row.jan, row.gtin, row.ean, row.upc].includes(expected));
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

const modules = {
  "server-only": {},
  "@/lib/intelligence/currency-confidence": { assessCurrencyConfidence: () => ({ confidence: "high", reasons: [] }) },
  "@/lib/supabase/admin": { createSupabaseAdminClient: () => { throw new Error("test must inject a disposable DB"); } },
  "@/lib/sources/cj": {
    fetchCJProductVariants: async (productId) => [{ vid: supplierVariantId, barcode }],
    fetchCJVariantByVid: async (vid) => ({ vid, barcode }),
  },
  "@/lib/market/identifiers": {
    identifiersFromRecord: (value) => Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v.trim()])),
    marketplaceBarcodeCandidates: (value) => [value],
    matchProductIdentity: ({ market, supply }) => ({ salesEligible: market.gtin === supply.gtin || market.jan === supply.gtin, confidence: 0.98, method: "gtin", rationale: "exact identifier" }),
  },
  "@/lib/market/variant-barcode-proof": {
    exactVariantBarcodeMethod: (market, supply) => [market.jan, market.gtin, market.ean, market.upc].includes(supply.gtin) ? "gtin" : null,
    hasUniqueCanonicalVariantMatch: (matchCount, productCount) => matchCount === 1 && productCount === 1,
  },
  "@/lib/suppliers/cj-identity-reverify-policy": {
    readExactSupplierVariantBarcode: (variants, requestedId) => {
      const matches = variants.filter((variant) => variant.vid === requestedId);
      return matches.length === 1 && typeof matches[0].barcode === "string" && matches[0].barcode.trim() ? matches[0].barcode.trim() : null;
    },
  },
};
const module = { exports: {} };
const context = {
  module, exports: module.exports,
  require: (id) => {
    if (!(id in modules)) throw new Error(`Unexpected import in persistence test: ${id}`);
    return modules[id];
  },
  console, Date, Set, Map, Object, Number, String, Array, Math, Error, JSON,
};
vm.runInNewContext(js, context, { filename: "persist-cj-supply-intelligence.compiled.cjs" });
const { persistCjSupplyIntelligence } = module.exports;

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
  const result = await persistCjSupplyIntelligence(args, { db, now: () => new Date("2026-10-10T00:00:00.000Z") });
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
  const result = await persistCjSupplyIntelligence(args, { db });
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
  const db = new FakeDb({ failUpdateTable: "supplier_listings" });
  await assert.rejects(() => persistCjSupplyIntelligence(args, { db, identity: null }), /supplier evidence persistence failed/);
  assert.equal(db.tables.product_offers.length, 0, "failed listing write must not continue to offer persistence");
  assert.equal(db.tables.product_intelligence.length, 0, "failed listing write must not continue to intelligence persistence");
}

console.log("PASS: application persistence path; exact unique match; ambiguous match clears stale identity; procurement flags remain false; no canonical writes on no-match; listing-write failure halts downstream writes.");
