import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const [gateSource, typesSource] = await Promise.all([
  readFile(new URL("../lib/ordering/gates.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ordering/types.ts", import.meta.url), "utf8"),
]);
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
};
const compiledTypes = ts.transpileModule(typesSource, { compilerOptions }).outputText;
const typesUrl = `data:text/javascript;base64,${Buffer.from(compiledTypes).toString("base64")}`;
const compiledGate = ts.transpileModule(
  gateSource.replace('from "@/lib/ordering/types"', `from "${typesUrl}"`),
  { compilerOptions },
).outputText;
const { evaluateOrderGates, verifyOrderGateInvariants } = await import(
  `data:text/javascript;base64,${Buffer.from(compiledGate).toString("base64")}`
);

const invariantResult = verifyOrderGateInvariants();
const invariantFailures = invariantResult.cases.filter((item) => item.actual !== item.expected);
assert.equal(invariantResult.ok, true, `Order gate invariants failed: ${JSON.stringify(invariantFailures)}`);

const base = {
  identityConfirmed: true,
  identityUnknown: false,
  supplierConfirmed: true,
  sourceCost: 3,
  currency: "USD",
  currencyReliable: true,
  shippable: true,
  complianceRisk: false,
  profitCalculable: true,
  forecastProfit30d: 80,
  forecastUnits30d: 20,
  onHand: 5,
  recommendedQty: 25,
  estimatedCost: 75,
  supplierApiAvailable: true,
  settings: {
    mode: "AUTO",
    dailyOrderLimit: null,
    perProductOrderLimit: null,
    monthlyOrderBudget: null,
    categoryBudgets: {},
    defaultLeadTimeDays: 7,
    defaultSafetyStock: 10,
  },
  spentToday: 0,
  spentMonth: 0,
  spentProduct: 0,
  spentCategory: 0,
  category: "auto",
};
assert.equal(evaluateOrderGates(base, 0.82).canAuto, true, "positive forecast profit should pass this gate");
for (const forecastProfit30d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const result = evaluateOrderGates({ ...base, forecastProfit30d }, 0.82);
  assert.equal(result.canAuto, false, `profit ${forecastProfit30d} must block auto ordering`);
  assert.equal(result.blocked.includes("non_positive_profit"), true);
}
const unknown = evaluateOrderGates({ ...base, forecastProfit30d: null }, 0.82);
assert.equal(unknown.canAuto, false);
assert.equal(unknown.missing.includes("profit_amount_unknown"), true);

const unknownDailySpend = evaluateOrderGates({
  ...base,
  settings: { ...base.settings, dailyOrderLimit: 100 },
  spentToday: null,
}, 0.82);
assert.equal(unknownDailySpend.canAuto, false, "unknown existing spend must never pass a configured budget");
assert.equal(unknownDailySpend.canPropose, false);
assert.equal(unknownDailySpend.missing.includes("daily_spend_unknown"), true);

const invalidMonthlySpend = evaluateOrderGates({
  ...base,
  settings: { ...base.settings, monthlyOrderBudget: 1000 },
  spentMonth: Number.NaN,
}, 0.82);
assert.equal(invalidMonthlySpend.canAuto, false, "invalid monthly spend must fail closed");
assert.equal(invalidMonthlySpend.missing.includes("monthly_spend_unknown"), true);

const unknownCostWithCategoryBudget = evaluateOrderGates({
  ...base,
  estimatedCost: null,
  settings: { ...base.settings, categoryBudgets: { auto: 500 } },
  category: "auto",
}, 0.82);
assert.equal(unknownCostWithCategoryBudget.canPropose, false, "unknown cost must block configured category budgets");
assert.equal(unknownCostWithCategoryBudget.missing.includes("budget_check_cost_unknown"), true);
console.log(`Order gate: ${invariantResult.cases.length} existing invariants + 6 forecast-profit checks passed`);
