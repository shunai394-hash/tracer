import assert from "node:assert/strict";
import { calculateSupplySellingPriceJpy, resolveUnknownShippingAllowanceUsd } from "../lib/market/supply-pricing.ts";

assert.equal(resolveUnknownShippingAllowanceUsd(undefined), 15, "unknown shipping defaults to a non-zero allowance");
assert.equal(resolveUnknownShippingAllowanceUsd("22.5"), 22.5, "shipping allowance can be configured per business");
assert.equal(resolveUnknownShippingAllowanceUsd("0"), 15, "zero cannot silently disable the shipping reserve");
assert.equal(resolveUnknownShippingAllowanceUsd("9999"), 15, "unreasonable configured allowances fall back to the default");

const fees = {
  platformFeeRate: 0.10,
  paymentFeeRate: 0.036,
  advertisingAllowanceRate: 0.15,
  returnRefundReserveRate: 0.05,
  fxReserveRate: 0.03,
};
const actualFreight = calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
});
assert.equal(actualFreight, 4900, "price is derived from actual supplier cost and quoted freight");
const estimatedFreight = calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: 15,
  sourceFxRateToSelling: 150,
  ...fees,
});
assert.equal(estimatedFreight, 8700, "labelled allowance can be used for a separate sales-test estimate");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: null,
  sourceFxRateToSelling: 150,
  ...fees,
}), null, "unknown freight cannot be silently treated as zero");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: null,
  ...fees,
}), null, "unknown FX cannot produce a price");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 0,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
}), actualFreight, "invalid stored zero price is recalculated");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 2500,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
}), 4900, "a stored price below the landed-cost margin floor is raised");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 5200,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
}), 5200, "a stored price above the margin floor is preserved");
console.log("Supply landed-price calculation: 7 cases passed");
