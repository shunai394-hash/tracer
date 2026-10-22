export function calculateSellingPrice(input) {
  const { unitCostJpy, shippingCostJpy, feeRate } = input;
  const fixedFeeJpy = input.fixedFeeJpy ?? 0;
  const targetMarginRate = input.targetMarginRate ?? 0.5;
  for (const [name, value] of Object.entries({ unitCostJpy, shippingCostJpy, feeRate, fixedFeeJpy, targetMarginRate })) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_" + name);
  }
  if (feeRate + targetMarginRate >= 1) throw new Error("invalid_rate");
  const base = unitCostJpy + shippingCostJpy + fixedFeeJpy;
  // BASE rejects item prices below ¥50. Apply the provider minimum before
  // validating fees and margin so both storefronts receive the same valid price.
  let sellingPrice = Math.max(50, Math.ceil(base / (1 - feeRate - targetMarginRate)));
  let feeAmount = 0;
  let expectedProfit = 0;
  // Account for integer-yen and rounded platform fees, not just the ideal ratio.
  for (let i = 0; i < 10000; i++) {
    feeAmount = Math.ceil(sellingPrice * feeRate) + fixedFeeJpy;
    expectedProfit = sellingPrice - unitCostJpy - shippingCostJpy - feeAmount;
    if (expectedProfit > 0 && expectedProfit / sellingPrice >= targetMarginRate) break;
    sellingPrice += 1;
  }
  if (expectedProfit <= 0 || expectedProfit / sellingPrice < targetMarginRate) throw new Error("price_calculation_did_not_converge");
  return { sellingPrice, feeAmount, expectedProfit, marginRate: expectedProfit / sellingPrice };
}
