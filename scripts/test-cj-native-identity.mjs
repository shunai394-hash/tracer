import assert from "node:assert/strict";
import { mock } from "node:test";

// CJ-native identity proof contract. CJ is never called: every live reader is
// a stub, and the database is an in-memory recorder.
process.env.CJ_API_KEY = process.env.CJ_API_KEY || "ci-cj-key";

const linkedRows = { data: [], error: null };
mock.module("@/lib/supabase/admin", {
  exports: {
    createSupabaseAdminClient: () => ({
      from: () => {
        const api = { select: () => api, in: () => Promise.resolve(linkedRows) };
        return api;
      },
    }),
  },
});

const {
  CJ_NATIVE_IDENTITY_METHOD,
  evaluateCjNativeIdentity,
  isCjNativeIdentityFresh,
  normalizeImageUrl,
} = await import("../lib/procurement/cj-native-identity.ts");
const { observeCjNativeIdentity, recordCjNativeIdentity } = await import("../lib/suppliers/verify-cj-native-identity.ts");
const { getLinkedSupplierListingIds } = await import("../lib/catalog/canonical-supplier-identity.ts");
const { evaluateChannelListingEligibility } = await import("../lib/market/channel-listing-eligibility.ts");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (error) {
    failures += 1;
    console.error("FAIL", name, error);
    process.exitCode = 1;
  }
}

const IMAGE = "https://cf.cjdropshipping.com/abc/product.jpg";
function observation(overrides = {}) {
  return {
    stored: {
      supplierProductId: "pid-1",
      supplierVariantId: "vid-1",
      listingImageUrl: `${IMAGE}?w=600`,
      listingTitle: "Desk Lamp White",
      duplicateRowCount: 1,
      ...(overrides.stored ?? {}),
    },
    live: {
      variant: { vid: "vid-1", productId: "pid-1", nameEn: "White", sellPrice: "4.20" },
      productVariantIds: ["vid-1", "vid-2"],
      productImageUrl: IMAGE,
      stock: 25,
      jpFreight: 6.5,
      ...(overrides.live ?? {}),
    },
    observedAt: "2026-10-13T00:00:00.000Z",
  };
}

await test("all evidence present verifies and records live values", () => {
  const decision = evaluateCjNativeIdentity(observation());
  assert.equal(decision.verified, true, decision.reasons.join(","));
  assert.equal(decision.method, CJ_NATIVE_IDENTITY_METHOD);
  assert.equal(decision.evidence.result, "verified");
  assert.equal(decision.evidence.live_price_usd, 4.2);
  assert.equal(decision.evidence.live_stock, 25);
  assert.equal(decision.evidence.jp_freight_usd, 6.5);
  assert.equal(decision.evidence.observed_at, "2026-10-13T00:00:00.000Z");
});

const rejections = [
  ["missing product id", { stored: { supplierProductId: "" } }, "supplier_product_id_missing"],
  ["missing variant id", { stored: { supplierVariantId: null } }, "supplier_variant_id_missing"],
  ["duplicate supplier rows", { stored: { duplicateRowCount: 2 } }, "supplier_identity_ambiguous"],
  ["duplicate lookup failed", { stored: { duplicateRowCount: -1 } }, "supplier_identity_ambiguous"],
  ["variant lookup failed", { live: { variant: null } }, "cj_variant_lookup_failed"],
  ["variant id differs", { live: { variant: { vid: "vid-9", productId: "pid-1", nameEn: "White", sellPrice: 4 } } }, "cj_variant_id_mismatch"],
  ["variant belongs to another product", { live: { variant: { vid: "vid-1", productId: "pid-2", nameEn: "White", sellPrice: 4 } } }, "cj_product_id_mismatch"],
  ["product variants lookup failed", { live: { productVariantIds: null } }, "cj_product_variants_lookup_failed"],
  ["variant missing from product", { live: { productVariantIds: ["vid-2", "vid-3"] } }, "cj_variant_not_unique_in_product"],
  ["variant listed twice", { live: { productVariantIds: ["vid-1", "vid-1"] } }, "cj_variant_not_unique_in_product"],
  ["title does not name the variant", { stored: { listingTitle: "Desk Lamp Black" } }, "variant_spec_unconfirmed"],
  ["price unknown", { live: { variant: { vid: "vid-1", productId: "pid-1", nameEn: "White", sellPrice: null } } }, "cj_price_unconfirmed"],
  ["stock lookup failed", { live: { stock: null } }, "cj_stock_unknown"],
  ["stock zero", { live: { stock: 0 } }, "cj_stock_zero"],
  ["no Japan freight", { live: { jpFreight: null } }, "jp_shipping_unavailable"],
  ["no listing image", { stored: { listingImageUrl: null } }, "listing_image_missing"],
  ["CJ image unavailable", { live: { productImageUrl: null } }, "cj_product_image_unavailable"],
  ["listing image differs from CJ", { stored: { listingImageUrl: "https://example.com/other.jpg" } }, "listing_image_not_cj_product_image"],
];
for (const [name, overrides, reason] of rejections) {
  await test(`rejects: ${name}`, () => {
    const decision = evaluateCjNativeIdentity(observation(overrides));
    assert.equal(decision.verified, false);
    assert.equal(decision.evidence.result, "rejected");
    assert.ok(decision.reasons.includes(reason), `${reason} not in ${decision.reasons.join(",")}`);
  });
}

await test("single-variant product needs no variant name in the title", () => {
  const decision = evaluateCjNativeIdentity(observation({ stored: { listingTitle: "Desk Lamp" }, live: { productVariantIds: ["vid-1"] } }));
  assert.equal(decision.verified, true, decision.reasons.join(","));
});

await test("image comparison ignores query strings only", () => {
  assert.equal(normalizeImageUrl(`${IMAGE}?x=1`), normalizeImageUrl(IMAGE));
  assert.notEqual(normalizeImageUrl("https://cf.cjdropshipping.com/abc/other.jpg"), normalizeImageUrl(IMAGE));
  assert.equal(normalizeImageUrl("ftp://cf.cjdropshipping.com/a.jpg"), null);
});

await test("freshness: within 24h only, unparsable fails closed", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  assert.equal(isCjNativeIdentityFresh("2026-10-13T00:00:00.000Z", now), true);
  assert.equal(isCjNativeIdentityFresh("2026-10-12T11:59:00.000Z", now), false);
  assert.equal(isCjNativeIdentityFresh("2026-10-13T13:00:00.000Z", now), false);
  assert.equal(isCjNativeIdentityFresh(null, now), false);
  assert.equal(isCjNativeIdentityFresh("not a date", now), false);
});

function memoryDb({ duplicates = [{ id: "sl-1" }], duplicateError = null, image = IMAGE, updateError = null } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const state = { table, payload: null, filters: [] };
      const api = {
        select: () => api,
        eq: (column, value) => { state.filters.push([column, value]); return api; },
        limit: () => Promise.resolve(duplicateError ? { data: null, error: duplicateError } : { data: duplicates, error: null }),
        maybeSingle: () => Promise.resolve({ data: { image_url: image }, error: null }),
        update: (payload) => { state.payload = payload; return api; },
        then: (resolve, reject) => {
          updates.push({ table: state.table, payload: state.payload, filters: state.filters });
          return Promise.resolve({ data: null, error: updateError }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

const row = {
  id: "sl-1",
  product_id: "prod-1",
  supplier_product_id: "pid-1",
  supplier_variant_id: "vid-1",
  title: "Desk Lamp White",
  identity_method: "supply_discovered",
  identity_status: "supply_discovered",
  metadata: { keep: true },
};
function readers(overrides = {}) {
  return {
    variantByVid: async () => ({ vid: "vid-1", productId: "pid-1", nameEn: "White", sellPrice: 4.2, sku: "S" }),
    productVariants: async () => [{ vid: "vid-1" }, { vid: "vid-2" }],
    productDetail: async () => ({ imageUrl: IMAGE }),
    variantStock: async () => 25,
    jpFreight: async () => 6.5,
    ...overrides,
  };
}

await test("observe: live readers that all agree verify", async () => {
  const decision = await observeCjNativeIdentity(memoryDb(), row, readers());
  assert.equal(decision.verified, true, decision.reasons.join(","));
});

await test("observe: a throwing CJ API call rejects instead of passing", async () => {
  const decision = await observeCjNativeIdentity(memoryDb(), row, readers({ variantStock: async () => { throw new Error("CJ 500"); } }));
  assert.equal(decision.verified, false);
  assert.ok(decision.reasons.includes("cj_stock_unknown"));
  const freight = await observeCjNativeIdentity(memoryDb(), row, readers({ jpFreight: async () => { throw new Error("timeout"); } }));
  assert.ok(freight.reasons.includes("jp_shipping_unavailable"));
});

await test("observe: duplicate supplier rows or a failed duplicate check reject", async () => {
  const dup = await observeCjNativeIdentity(memoryDb({ duplicates: [{ id: "sl-1" }, { id: "sl-2" }] }), row, readers());
  assert.ok(dup.reasons.includes("supplier_identity_ambiguous"));
  const failed = await observeCjNativeIdentity(memoryDb({ duplicateError: { message: "boom" } }), row, readers());
  assert.ok(failed.reasons.includes("supplier_identity_ambiguous"));
});

await test("record: verified proof links the row with live evidence", async () => {
  const db = memoryDb();
  const decision = evaluateCjNativeIdentity(observation());
  const result = await recordCjNativeIdentity(db, row, decision);
  assert.equal(result.changed, "linked");
  const payload = db.updates[0].payload;
  assert.equal(payload.identity_method, CJ_NATIVE_IDENTITY_METHOD);
  assert.equal(payload.identity_status, "linked");
  assert.equal(payload.cost, 4.2);
  assert.equal(payload.shipping_cost, 6.5);
  assert.equal(payload.inventory, 25);
  assert.equal(payload.metadata.keep, true);
  assert.equal(payload.metadata.cj_native_identity.result, "verified");
  assert.deepEqual(db.updates[0].filters, [["id", "sl-1"]]);
});

await test("record: rejected proof downgrades a CJ-native row", async () => {
  const db = memoryDb();
  const decision = evaluateCjNativeIdentity(observation({ live: { stock: null } }));
  const result = await recordCjNativeIdentity(db, { ...row, identity_method: CJ_NATIVE_IDENTITY_METHOD, identity_status: "linked" }, decision);
  assert.equal(result.changed, "downgraded");
  const payload = db.updates[0].payload;
  assert.equal(payload.identity_status, "supply_discovered");
  assert.equal(payload.orderable, false);
  assert.match(payload.verification_error, /cj_stock_unknown/);
});

await test("record: rejected proof on an unlinked row writes evidence only", async () => {
  const db = memoryDb();
  const result = await recordCjNativeIdentity(db, row, evaluateCjNativeIdentity(observation({ live: { stock: 0 } })));
  assert.equal(result.changed, "evidence_only");
  assert.deepEqual(Object.keys(db.updates[0].payload), ["metadata"]);
});

await test("record: marketplace-linked rows are never relinked or downgraded", async () => {
  const db = memoryDb();
  const linked = { ...row, identity_method: "jan", identity_status: "linked" };
  for (const decision of [evaluateCjNativeIdentity(observation()), evaluateCjNativeIdentity(observation({ live: { stock: 0 } }))]) {
    const result = await recordCjNativeIdentity(db, linked, decision);
    assert.equal(result.changed, "skipped_marketplace_linked");
  }
  for (const update of db.updates) assert.deepEqual(Object.keys(update.payload), ["metadata"]);
});

await test("record: a failed write is reported", async () => {
  const result = await recordCjNativeIdentity(memoryDb({ updateError: { message: "denied" } }), row, evaluateCjNativeIdentity(observation()));
  assert.equal(result.ok, false);
  assert.equal(result.error, "denied");
});

await test("linked gate: CJ-native proof counts only while verified and fresh", async () => {
  const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  linkedRows.data = [
    { id: "jan-linked", identity_status: "linked", identity_method: "jan", cj_native_result: null, cj_native_observed_at: null },
    { id: "cj-fresh", identity_status: "linked", identity_method: CJ_NATIVE_IDENTITY_METHOD, cj_native_result: "verified", cj_native_observed_at: fresh },
    { id: "cj-stale", identity_status: "linked", identity_method: CJ_NATIVE_IDENTITY_METHOD, cj_native_result: "verified", cj_native_observed_at: stale },
    { id: "cj-rejected", identity_status: "linked", identity_method: CJ_NATIVE_IDENTITY_METHOD, cj_native_result: "rejected", cj_native_observed_at: fresh },
    { id: "cj-no-proof", identity_status: "linked", identity_method: CJ_NATIVE_IDENTITY_METHOD, cj_native_result: null, cj_native_observed_at: null },
    { id: "discovered", identity_status: "supply_discovered", identity_method: "supply_discovered", cj_native_result: null, cj_native_observed_at: null },
  ];
  const linked = await getLinkedSupplierListingIds(linkedRows.data.map((item) => item.id));
  assert.deepEqual([...linked].sort(), ["cj-fresh", "jan-linked"]);
});

function eligibility(overrides = {}) {
  return {
    title: "LEDデスクライト ホワイト",
    description: "USB給電のLEDデスクライトです。角度調整ができ、机の上をやさしく照らします。",
    imageUrl: IMAGE,
    imageReachable: true,
    sellingPrice: 3980,
    currency: "JPY",
    sourceCost: 600,
    shippingCost: 0,
    contributionProfit: 1200,
    profitCalculable: true,
    currencyMismatch: false,
    inventory: 25,
    inventoryConfirmed: true,
    orderable: true,
    trackingAvailable: true,
    supplierProductId: "pid-1",
    supplierVariantId: "vid-1",
    identityLinked: true,
    identityMethod: CJ_NATIVE_IDENTITY_METHOD,
    identityConfidence: 1,
    salesTestPassed: true,
    supplierName: "cj",
    supplierAdapterRegistered: true,
    ...overrides,
  };
}

await test("channel gate: CJ-native proof is not identity for a non-CJ supplier", () => {
  const decision = evaluateChannelListingEligibility(eligibility({ supplierName: "netsea" }));
  assert.ok(decision.reasons.includes("identity_not_confirmed"));
});

await test("channel gate: CJ-native proof satisfies identity for CJ but CJ stays blocked until live ordering is approved", () => {
  const decision = evaluateChannelListingEligibility(eligibility());
  assert.equal(decision.reasons.includes("identity_not_confirmed"), false);
  assert.equal(decision.eligible, false, "CJ live ordering is disabled, so CJ supply must not be sellable");
});

if (failures === 0) console.log("PASS cj native identity");
