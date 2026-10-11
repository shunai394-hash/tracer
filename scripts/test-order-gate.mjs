import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gates = await readFile(new URL("../lib/ordering/gates.ts", import.meta.url), "utf8");

assert.match(gates, /forecastProfit30d === null/, "unknown forecast profit must be blocked");
assert.match(gates, /forecastProfit30d <= 0/, "zero or negative forecast profit must be blocked");
assert.match(gates, /sourceCost <= 0/, "zero or negative source cost must be blocked");
assert.match(gates, /name: "non_positive_profit_blocks_order"/, "zero-profit regression case must remain in the invariant suite");
assert.match(gates, /name: "zero_source_cost_blocks_order"/, "zero-source-cost regression case must remain in the invariant suite");
assert.match(gates, /name: "unknown_profit_blocks_auto"/, "unknown-profit regression case must remain in the invariant suite");

console.log("Order gate fail-closed source guards: 6 passed");
