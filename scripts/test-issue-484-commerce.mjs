import assert from "node:assert/strict";
import { assessCommercialTerms } from "../lib/market/commercial-terms.ts";
import { evaluateShopListingRecord } from "../lib/market/listing-commercial-gate.ts";
import { attachSupplierCommercialEvidence } from "../lib/market/supplier-commercial-evidence.ts";
import { uniqueRowsByKey } from "../lib/ordering/channel-listing-match.ts";
import { evaluateDropshipOrderGate } from "../lib/ordering/dropship-gate.ts";
import { selectShopifyVariantForSku } from "../lib/shopify/sync-published-listings.ts";

const NOW = Date.parse("2026-10-13T00:00:00.000Z");
const FRESH = "2026-10-12T12:00:00.000Z";
const STALE = "2026-10-11T00:00:00.000Z";
const DESCRIPTION = "床に敷いて使うフロアマットです。室内用の日本製サイズです。";

function listing(overrides = {}) {
  return {
    title: "床用フロアマット",
    description: DESCRIPTION,
    image_url: "https://example.test/mat.jpg",
    selling_price: 3980,
    currency: "JPY",
    source_currency: "JPY",
    source_cost: 1000,
    shipping_cost: 300,
    inventory: 5,
    orderable: true,
    tracking_available: true,
    selection_reasons: ["sales_test_gate_passed", "inventory_confirmed"],
    supplier_name: "tracer_internal",
    supplier_product_id: "supply-product",
    supplier_variant_id: "supply-variant",
    identity_method: "jan",
    identity_confidence: 0.95,
    pipeline_status: "published",
    pipeline_stage: "PUBLISHED",
    pipeline_reason: "sales_test_gate_passed",
    ...overrides,
  };
}

const results = [];
function test(name, fn) {
  results.push(name);
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("PASS", name))
    .catch((error) => {
      console.error("FAIL", name, error);
      process.exitCode = 1;
    });
}

await test("commercial terms reject missing, stale, and stringified currencies", () => {
  const usd = assessCommercialTerms({
    sellingCurrency: "JPY",
    sourceCurrency: "USD",
    sourceCost: 10,
    shippingCost: 2,
    sellingPrice: 3980,
    fxRate: null,
    fxObservedAt: null,
    nowMs: NOW,
  });
  assert.equal(usd.currencyMismatch, true);
  assert.equal(usd.profitCalculable, false);
  assert.equal(usd.contributionProfit, null);
  assert.ok(usd.reasons.includes("fx_unavailable"));

  const stale = assessCommercialTerms({
    sellingCurrency: "JPY",
    sourceCurrency: "USD",
    sourceCost: 10,
    shippingCost: 2,
    sellingPrice: 3980,
    fxRate: 150,
    fxObservedAt: STALE,
    nowMs: NOW,
  });
  assert.equal(stale.currencyMismatch, true);
  assert.ok(stale.reasons.includes("fx_stale"));

  const freshLoss = assessCommercialTerms({
    sellingCurrency: "JPY",
    sourceCurrency: "USD",
    sourceCost: 20,
    shippingCost: 10,
    sellingPrice: 3980,
    fxRate: 150,
    fxObservedAt: FRESH,
    nowMs: NOW,
  });
  assert.equal(freshLoss.currencyMismatch, false);
  assert.equal(freshLoss.contributionProfit, 3980 - 30 * 150);

  const freshGain = assessCommercialTerms({
    sellingCurrency: "JPY",
    sourceCurrency: "USD",
    sourceCost: 10,
    shippingCost: 2,
    sellingPrice: 3980,
    fxRate: 150,
    fxObservedAt: FRESH,
    nowMs: NOW,
  });
  assert.equal(freshGain.contributionProfit, 3980 - 12 * 150);
  assert.equal(freshGain.profitCalculable, true);

  const bothJpy = assessCommercialTerms({
    sellingCurrency: "JPY",
    sourceCurrency: "JPY",
    sourceCost: 1000,
    shippingCost: 300,
    sellingPrice: 3980,
    fxRate: null,
    fxObservedAt: null,
    nowMs: NOW,
  });
  assert.equal(bothJpy.currencyMismatch, false);
  assert.equal(bothJpy.contributionProfit, 2680);

  for (const sourceCurrency of [null, "null", "USD "]) {
    const rejected = assessCommercialTerms({
      sellingCurrency: "JPY",
      sourceCurrency,
      sourceCost: 1000,
      shippingCost: 300,
      sellingPrice: 3980,
      fxRate: 150,
      fxObservedAt: FRESH,
      nowMs: NOW,
    });
    if (sourceCurrency === "USD ") {
      assert.equal(rejected.currencyMismatch, false);
      assert.equal(rejected.contributionProfit, 3980 - 1300 * 150);
    } else {
      assert.equal(rejected.currencyMismatch, true);
      assert.ok(rejected.reasons.includes("source_currency_unknown"));
      assert.equal(rejected.contributionProfit, null);
    }
  }
});

await test("listing gate blocks unresolved currency, profit, inventory, and variant identity", () => {
  const ready = evaluateShopListingRecord(listing(), true, { supplierAdapterRegistered: true, salesTestPassed: true });
  assert.equal(ready.eligible, true, ready.reasons.join(","));

  for (const marketplace of ["amazon.co.jp", "amazon", "rakuten"]) {
    const removedSource = evaluateShopListingRecord(
      listing({ marketplace }),
      true,
      { supplierAdapterRegistered: true, salesTestPassed: true },
    );
    assert.equal(removedSource.eligible, false, `${marketplace} must be excluded by shared gate`);
    assert.ok(removedSource.reasons.includes("source_marketplace_removed_by_policy"));
  }

  const usd = evaluateShopListingRecord(listing({ source_currency: "USD", contribution_profit: 99999 }), true, { supplierAdapterRegistered: true, salesTestPassed: true });
  assert.equal(usd.eligible, false);
  assert.ok(usd.reasons.includes("profit_unknown"));

  const unconfirmed = evaluateShopListingRecord(listing({ selection_reasons: ["sales_test_gate_passed"], inventory: null }), true, { supplierAdapterRegistered: true, salesTestPassed: true });
  assert.equal(unconfirmed.eligible, false);
  assert.ok(unconfirmed.reasons.includes("inventory_unconfirmed"));

  const blankVariant = evaluateShopListingRecord(listing({ supplier_variant_id: "  " }), true, { supplierAdapterRegistered: true, salesTestPassed: true });
  assert.equal(blankVariant.eligible, false);
  assert.ok(blankVariant.reasons.includes("supplier_variant_unknown"));
});

await test("supplier currency is attached from the supplier listing and never invented", async () => {
  let queried = false;
  const client = {
    from(table) {
      assert.equal(table, "supplier_listings");
      return {
        select() {
          return {
            in(column, values) {
              queried = true;
              assert.equal(column, "id");
              assert.deepEqual(values, ["supplier-1"]);
              return Promise.resolve({
                data: [{ id: "supplier-1", currency: "USD", metadata: { fx_rate: 150, fx_observed_at: FRESH } }],
                error: null,
              });
            },
          };
        },
      };
    },
  };
  const [attached] = await attachSupplierCommercialEvidence(client, [{ supplier_listing_id: "supplier-1", source_currency: "" }]);
  assert.equal(queried, true);
  assert.equal(attached.source_currency, "USD");
  assert.equal(attached.fx_rate, 150);
  assert.equal(attached.fx_observed_at, FRESH);
  const [kept] = await attachSupplierCommercialEvidence(client, [{ supplier_listing_id: "supplier-1", source_currency: "JPY" }]);
  assert.equal(kept.source_currency, "JPY");
});

await test("ambiguous channel ids and Shopify SKUs fail closed", () => {
  const matched = uniqueRowsByKey([
    { id: "a", key: "variant-1" },
    { id: "b", key: "variant-1" },
    { id: "c", key: "variant-2" },
    { id: "d", key: "" },
  ], (row) => row.key || null);
  assert.deepEqual(matched.ambiguousKeys, ["variant-1"]);
  assert.equal(matched.unique.size, 1);
  assert.equal(matched.unique.get("variant-2").id, "c");

  const ambiguous = selectShopifyVariantForSku([
    { id: "v1", sku: "TRC-1" },
    { id: "v2", sku: "TRC-1" },
  ], "TRC-1");
  assert.equal(ambiguous.error, "shopify_variant_sku_ambiguous");
  const mismatch = selectShopifyVariantForSku([{ id: "v1", sku: "OTHER" }], "TRC-1");
  assert.equal(mismatch.error, "shopify_variant_sku_mismatch");
});

await test("dropship gate blocks a cross-currency order without FX evidence", () => {
  const blocked = evaluateDropshipOrderGate({
    vid: "variant-1",
    quantity: 1,
    sourceCost: 10,
    shippingCost: 2,
    currency: "USD",
    sellingPrice: 3980,
    sourceFxRateToSelling: null,
    addressComplete: true,
    killSwitchBlocked: false,
    supplierConfigured: true,
    cjConfigured: false,
    liveOrderingEnabled: false,
    inventoryQty: 4,
    duplicateOrderExists: false,
  });
  assert.equal(blocked.canExecuteLive, false);
  assert.ok(blocked.missing.includes("fx_rate_unknown"));
  const duplicate = evaluateDropshipOrderGate({
    vid: "variant-1",
    quantity: 1,
    sourceCost: 1000,
    shippingCost: 300,
    currency: "JPY",
    sellingPrice: 3980,
    sourceFxRateToSelling: 1,
    addressComplete: true,
    killSwitchBlocked: false,
    supplierConfigured: true,
    cjConfigured: false,
    liveOrderingEnabled: true,
    inventoryQty: 4,
    duplicateOrderExists: true,
  });
  assert.equal(duplicate.canExecuteLive, false);
  assert.ok(duplicate.blocked.includes("duplicate_order"));
});

await Promise.all(results.map(() => Promise.resolve()));
if (process.exitCode) process.exit(process.exitCode);
console.log(`issue-484 commerce tests ${results.length}/${results.length}`);
