export function calculateSellingPrice(input) {
  const { unitCostJpy, shippingCostJpy, feeRate } = input;
  const fixedFeeJpy = input.fixedFeeJpy ?? 0;
  const targetMarginRate = input.targetMarginRate ?? 0.2;
  for (const [name, value] of Object.entries({ unitCostJpy, shippingCostJpy, feeRate, fixedFeeJpy, targetMarginRate })) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_" + name);
  }
  if (feeRate >= 1 || targetMarginRate >= 1 || feeRate + targetMarginRate >= 1) throw new Error("invalid_rate");
  const base = unitCostJpy + shippingCostJpy + fixedFeeJpy;
  const sellingPrice = Math.ceil(base / (1 - feeRate - targetMarginRate));
  const feeAmount = Math.ceil(sellingPrice * feeRate) + fixedFeeJpy;
  const expectedProfit = sellingPrice - unitCostJpy - shippingCostJpy - feeAmount;
  return { sellingPrice, feeAmount, expectedProfit, marginRate: sellingPrice > 0 ? expectedProfit / sellingPrice : 0 };
}
