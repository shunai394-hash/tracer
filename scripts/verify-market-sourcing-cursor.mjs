import assert from "node:assert/strict";
import { getMarketSourcingCursor } from "../lib/market/market-sourcing-cursor.ts";

const common = {
  currentSourceIndex: 3,
  nextSourceIndex: 4,
  currentStartIndex: 200,
  nextStartIndex: 400,
};

assert.deepEqual(
  getMarketSourcingCursor({ ...common, evidenceWriteFailed: true }),
  { sourceIndex: 3, nextIndex: 200 },
  "schema/write failure must retry the exact same source and page",
);
assert.deepEqual(
  getMarketSourcingCursor({ ...common, evidenceWriteFailed: false }),
  { sourceIndex: 4, nextIndex: 400 },
  "a successful evidence batch may advance to the next page",
);
assert.deepEqual(
  getMarketSourcingCursor({
    evidenceWriteFailed: true,
    currentSourceIndex: 7,
    nextSourceIndex: 0,
    currentStartIndex: 0,
    nextStartIndex: 0,
  }),
  { sourceIndex: 7, nextIndex: 0 },
  "a failed final page must not rotate to the next marketplace",
);

console.log("PASS: failed evidence batches retain the cursor; successful batches advance");
