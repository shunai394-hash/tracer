import assert from "node:assert/strict";
import { getMarketSourcingCursor } from "../lib/market/market-sourcing-cursor.ts";

const common = {
  currentSourceIndex: 3,
  nextSourceIndex: 4,
  currentStartIndex: 200,
  nextStartIndex: 400,
};

assert.deepEqual(
  getMarketSourcingCursor({ ...common, failureKind: "write_failed" }),
  { sourceIndex: 3, nextIndex: 200 },
  "write failure must retry the exact same source and page",
);
assert.deepEqual(
  getMarketSourcingCursor({ ...common, failureKind: "schema_probe_error" }),
  { sourceIndex: 3, nextIndex: 200 },
  "transient schema probe errors must retry the same page",
);
assert.deepEqual(
  getMarketSourcingCursor({ ...common, failureKind: "schema_missing" }),
  { sourceIndex: 4, nextIndex: 400 },
  "a confirmed missing table must not hot-loop the same batch; replay is required",
);
assert.deepEqual(
  getMarketSourcingCursor({ ...common, failureKind: "none" }),
  { sourceIndex: 4, nextIndex: 400 },
  "a successful evidence batch may advance to the next page",
);
assert.deepEqual(
  getMarketSourcingCursor({
    failureKind: "write_failed",
    currentSourceIndex: 7,
    nextSourceIndex: 0,
    currentStartIndex: 0,
    nextStartIndex: 0,
  }),
  { sourceIndex: 7, nextIndex: 0 },
  "a failed final page must not rotate to the next marketplace",
);

console.log("PASS: write/probe failures retry; missing schema advances with replay required");
