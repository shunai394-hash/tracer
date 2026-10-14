import assert from "node:assert/strict";
import { duplicateGroups, normalizedBaseExternalId, reconcileBaseIds } from "./base-reconciliation-core.mjs";

assert.equal(normalizedBaseExternalId(123), "123");
assert.equal(normalizedBaseExternalId(" 00123 "), "00123");
assert.equal(normalizedBaseExternalId(null), null);
assert.equal(normalizedBaseExternalId(""), null);
assert.equal(normalizedBaseExternalId("abc"), null);
assert.deepEqual(
  duplicateGroups([{ id: "7" }, { id: "7" }, { id: "8" }], (row) => row.id),
  [{ id: "7", count: 2 }],
);

const result = reconcileBaseIds(
  [
    { id: "db-a", base_item_id: "100" },
    { id: "db-b", base_item_id: 200 },
    { id: "db-c", base_item_id: "200" },
    { id: "db-d", base_item_id: null },
  ],
  [
    { item_id: 100, visible: true },
    { item_id: 200, visible: true },
    { item_id: 300, visible: true },
    { item_id: 400, visible: false },
  ],
  [
    { item_id: 100, visible: true },
    { item_id: 200, visible: true },
    { item_id: 300, visible: true },
  ],
);

assert.equal(result.db.shopListingsTotal, 4);
assert.equal(result.db.rowsWithValidBaseExternalId, 3);
assert.equal(result.db.rowsWithoutValidBaseExternalId, 1);
assert.equal(result.db.duplicateBaseExternalIdGroups, 1);
assert.equal(result.reconciliation.visibleItemsMatchedToUniqueDbId, 1);
assert.deepEqual(result.reconciliation.visibleItemIdsNotFoundInDb, ["300"]);
assert.deepEqual(result.reconciliation.visibleItemIdsWithAmbiguousDbId, ["200"]);
assert.equal(result.reconciliation.visibleItemsWithAmbiguousDbId, 1);
assert.deepEqual(result.reconciliation.dbExternalIdsNotFoundInBaseList, []);
assert.deepEqual(result.reconciliation.dbExternalIdsPresentButHiddenOnBaseList, []);
assert.equal(result.reconciliation.ambiguousDbExternalIdGroups, 1);

const hiddenResult = reconcileBaseIds(
  [{ id: "db-a", base_item_id: "400" }],
  [{ item_id: "400", visible: false }],
  [],
);
assert.equal(hiddenResult.reconciliation.dbExternalIdsPresentButHiddenOnBase, 1);
assert.deepEqual(hiddenResult.reconciliation.dbExternalIdsPresentButHiddenOnBaseList, ["400"]);

const duplicateLiveResult = reconcileBaseIds(
  [{ id: "db-a", base_item_id: "100" }],
  [
    { item_id: 100, visible: true },
    { item_id: "100", visible: true },
  ],
  [
    { item_id: 100, visible: true },
    { item_id: "100", visible: true },
  ],
);
assert.equal(duplicateLiveResult.reconciliation.visibleItemsMatchedToUniqueDbId, 0);
assert.deepEqual(duplicateLiveResult.reconciliation.visibleItemIdsNotFoundInDb, []);
assert.deepEqual(duplicateLiveResult.reconciliation.visibleItemIdsWithAmbiguousBaseApiId, ["100"]);
assert.equal(duplicateLiveResult.reconciliation.visibleItemsWithAmbiguousBaseApiId, 1);
assert.equal(duplicateLiveResult.reconciliation.liveApiDuplicateExternalIdGroups, 1);

const publicationStateResult = reconcileBaseIds(
  [
    { id: "db-published-hidden", base_item_id: "501", published: true },
    { id: "db-unpublished-visible", base_item_id: "502", published: false },
    { id: "db-aligned-visible", base_item_id: "503", published: true },
  ],
  [
    { item_id: 501, visible: false },
    { item_id: 502, visible: true },
    { item_id: 503, visible: true },
  ],
  [
    { item_id: 502, visible: true },
    { item_id: 503, visible: true },
  ],
);
assert.deepEqual(publicationStateResult.reconciliation.dbPublishedButBaseHiddenIds, ["501"]);
assert.equal(publicationStateResult.reconciliation.dbPublishedButBaseHidden, 1);
assert.deepEqual(publicationStateResult.reconciliation.dbUnpublishedButBaseVisibleIds, ["502"]);
assert.equal(publicationStateResult.reconciliation.dbUnpublishedButBaseVisible, 1);

console.log("BASE external-ID reconciliation unit tests passed");
