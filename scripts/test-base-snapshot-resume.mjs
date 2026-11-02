import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendSnapshotRows, prepareSnapshotResume } from "../lib/channels/base-snapshot-checkpoint.ts";
import { missingSaleEvidence } from "../lib/commerce/sale-evidence.ts";

const prior = [{ item_id: "1", title: "kept" }, { item_id: "2", title: "kept" }];
const resumed = prepareSnapshotResume(prior, { nextOffset: 200, pagesFetched: 2, itemIds: ["1", "2"] });
assert.equal(resumed.offset, 200);
assert.equal(resumed.pages, 2);
assert.deepEqual(resumed.items.map((item) => item.item_id), ["1", "2"]);

assert.throws(
  () => prepareSnapshotResume(prior, { nextOffset: 200, pagesFetched: 2, itemIds: ["1"] }),
  /BASE_ITEMS_SNAPSHOT_CHECKPOINT_MISMATCH/,
);
assert.throws(
  () => prepareSnapshotResume([{ item_id: "1" }, { item_id: "1" }]),
  /BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE/,
);

const page = appendSnapshotRows(resumed.items, resumed.seen, [
  { item_id: "2", title: "duplicate" },
  { item_id: "3", title: "new" },
]);
assert.deepEqual(page, { added: 1, duplicates: 1 });
assert.deepEqual(resumed.items.map((item) => item.item_id), ["1", "2", "3"]);
assert.equal(resumed.items[1].title, "kept");

const complete = {
  supplierCode: "cj",
  supplierProductId: "p",
  supplierVariantId: "v",
  variantSku: "TRC-1",
  sourceStatus: "verified",
  stockKnown: true,
  inventory: 2,
  unitCost: 100,
  shippingKnown: true,
  shipTo: "JP",
  trackingSupported: true,
  currency: "JPY",
  sellingPrice: 6000,
  expectedProfit: 2600,
};
assert.deepEqual(missingSaleEvidence(complete), []);
assert.deepEqual(missingSaleEvidence({ ...complete, unitCost: 0 }), ["cost"]);
assert.deepEqual(missingSaleEvidence({ ...complete, supplierCode: null }), ["supplier"]);
assert.deepEqual(missingSaleEvidence({ ...complete, sourceStatus: "pending" }), ["verification"]);
assert.deepEqual(missingSaleEvidence(complete), []); // stale timestamps are not a sale blocker

const client = readFileSync(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
assert.match(client, /attempt <= 3/);
assert.match(client, /class BaseSnapshotInterrupted/);
assert.match(client, /resumeOffset=/);
assert.match(route, /resumable: true/);
assert.match(route, /priorItems/);
assert.doesNotMatch(route, /editBaseItem\(|createBaseItem\(|\.delete\(/);

console.log("BASE snapshot resume: ok");
