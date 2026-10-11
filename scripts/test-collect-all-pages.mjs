import assert from "node:assert/strict";
import { collectAllPages } from "../lib/db/collect-all-pages.ts";

const fixture = Array.from({ length: 2505 }, (_, id) => ({ id }));
const offsets = [];
const result = await collectAllPages(async (from, size) => {
  offsets.push({ from, size });
  return { data: fixture.slice(from, from + size), error: null };
});
assert.equal(result.error, null);
assert.equal(result.data.length, 2505, "all rows across multiple pages must be returned");
assert.deepEqual(result.data.map((row) => row.id), fixture.map((row) => row.id), "no row may be skipped or duplicated");
assert.deepEqual(offsets, [
  { from: 0, size: 1000 },
  { from: 1000, size: 1000 },
  { from: 2000, size: 1000 },
  { from: 3000, size: 1000 },
], "pagination must continue through the final partial page");

const failure = await collectAllPages(async (from, size) => {
  if (from === 1000) return { data: null, error: { message: "simulated page failure" } };
  return { data: fixture.slice(from, from + size), error: null };
});
assert.deepEqual(failure.data, [], "partial scans must not be used when a page read fails");
assert.equal(failure.error?.message, "simulated page failure");
assert.equal(failure.offset, 1000);

const invalid = await collectAllPages(async () => ({ data: [], error: null }), 0);
assert.equal(invalid.error?.message, "pageSize must be a positive integer");
console.log("Complete pagination helper: 3 behavioral scenarios passed (2,505 rows, page failure, invalid page size)");
