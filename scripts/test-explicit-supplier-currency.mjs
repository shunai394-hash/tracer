import assert from "node:assert/strict";
import { resolveSupplierFxRateToJpy } from "../lib/market/supply-pricing.ts";

assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "USD", metadataFxRate: 150, observedUsdToJpyRate: 151,
}), 150, "explicit USD/JPY metadata rate wins");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "USD", metadataFxRate: null, observedUsdToJpyRate: 151,
}), 151, "USD can use observed USD/JPY rate");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "JPY", metadataFxRate: 150, observedUsdToJpyRate: 151,
}), 1, "JPY-to-JPY conversion is exactly one");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "EUR", metadataFxRate: 164, metadataFxSourceCurrency: "EUR",
  metadataFxTargetCurrency: "JPY", observedUsdToJpyRate: 151,
}), 164, "other currencies require an explicitly matching source and JPY target");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "EUR", metadataFxRate: 164, metadataFxSourceCurrency: "USD",
  metadataFxTargetCurrency: "JPY", observedUsdToJpyRate: 151,
}), null, "USD rate must never be applied to EUR");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: null, metadataFxRate: 150, observedUsdToJpyRate: 151,
}), null, "missing supplier currency must not silently default to USD");
assert.equal(resolveSupplierFxRateToJpy({
  sourceCurrency: "GBP", metadataFxRate: null, observedUsdToJpyRate: 151,
}), null, "unsupported currency without matching FX evidence remains unresolved");
console.log("Explicit supplier currency and FX: 7 cases passed");
