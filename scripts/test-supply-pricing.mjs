import assert from "node:assert/strict";
import {
  calculateRecommendedSupplySellingPriceJpy,
  calculateSupplySellingPriceJpy,
  resolveUnknownShippingAllowanceUsd,
} from "../lib/market/supply-pricing.ts";

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
  targetContributionMargin: 0.50,
});
assert.equal(actualFreight, 15700, "a missing price is suggested to meet the 50% contribution margin target");
const estimatedFreight = calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: 15,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
});
assert.equal(estimatedFreight, 28000, "labelled allowance price meets the 50% contribution margin target");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: null,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
}), null, "unknown freight cannot be silently treated as zero");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: null,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: null,
  ...fees,
}), null, "unknown FX cannot produce a suggested price");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 0,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
}), actualFreight, "invalid stored zero price is recalculated");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 2500,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
}), 15700, "stored price below target is raised to the 50% margin floor");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 5200,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
}), 15700, "stored price above cost but below the 50% target is raised");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 2499.5,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
}), 15700, "fractional stored price below target is raised to a rounded safe price");
assert.equal(calculateSupplySellingPriceJpy({
  existingSellingPriceJpy: 2500,
  sourceCost: 10,
  shippingCost: null,
  sourceFxRateToSelling: null,
  ...fees,
}), 2500, "stored price remains unchanged when cost inputs are incomplete");
assert.equal(calculateRecommendedSupplySellingPriceJpy({
  existingSellingPriceJpy: 2500,
  sourceCost: 10,
  shippingCost: 4,
  sourceFxRateToSelling: 150,
  ...fees,
  targetContributionMargin: 0.50,
  targetContributionMargin: 0.20,
}), 4900, "recommended helper supports an explicit 20% target");
console.log("Supply pricing: 9 cases passed");
