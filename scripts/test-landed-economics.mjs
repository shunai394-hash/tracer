import assert from "node:assert/strict";
import { calculateLandedEconomics } from "../lib/suppliers/landed-economics.ts";

const base = {
  sellingPriceJpy: 2300,
  supplierCostJpy: 256.42,
  japanShippingJpy: 626.79,
  platformFeeRate: 0.05,
  paymentFeeRate: 0.036,
};

const positive = calculateLandedEconomics(base);
assert.equal(positive.ready, true);
assert.equal(positive.landedCostJpy, 883.21);
assert.equal(positive.platformFeeJpy, 115);
assert.equal(positive.paymentFeeJpy, 83);
assert.equal(positive.contributionProfitJpy, 1218.79);
assert.equal(positive.reason, null);

const unknownShipping = calculateLandedEconomics({ ...base, japanShippingJpy: null });
assert.equal(unknownShipping.ready, false);
assert.equal(unknownShipping.reason, "japan_shipping_missing_or_invalid");
assert.equal(unknownShipping.contributionProfitJpy, null);

const negativeProfit = calculateLandedEconomics({
  ...base, sellingPriceJpy: 900, supplierCostJpy: 2000, japanShippingJpy: 2000,
});
assert.equal(negativeProfit.ready, true);
assert.ok(Number.isFinite(negativeProfit.contributionProfitJpy), "computed contribution profit must be finite");
assert.ok((negativeProfit.contributionProfitJpy ?? 0) < 0, "loss-making scenario must calculate a negative contribution profit");
assert.equal(negativeProfit.reason, "contribution_profit_not_positive");

const invalidFee = calculateLandedEconomics({ ...base, platformFeeRate: 1 });
assert.equal(invalidFee.ready, false);
assert.equal(invalidFee.reason, "platform_fee_rate_missing_or_invalid");

console.log("landed economics policy: 4 scenarios passed");
