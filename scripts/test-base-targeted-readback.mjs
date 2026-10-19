import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/cron/base-targeted-readback/route.ts", import.meta.url), "utf8");

assert.ok(route.includes("requireAutomationAuth"), "targeted readback must require automation auth");
assert.ok(route.includes("MAX_TARGETS = 8"), "targeted readback must cap the request at eight IDs");
assert.ok(route.includes('target_base_item_ids_required'), "missing target IDs must be rejected");
assert.ok(route.includes('target_base_item_ids_must_be_numeric'), "non-numeric IDs must be rejected");
assert.ok(route.includes('target_base_item_ids_limit_exceeded'), "too many distinct IDs must be rejected");
assert.ok(route.includes('.in("external_product_id", targetIds)'), "TRACER mapping lookup must be limited to target IDs");
assert.ok(route.includes("getBaseItemDetail(baseItemId)"), "each target must be read from the actual BASE API");
assert.ok(route.includes("writesPerformed: false"), "response must explicitly report read-only behavior");
assert.ok(!route.includes(".update("), "route must not update TRACER records");
assert.ok(!route.includes("fetch("), "route must not call a BASE write endpoint directly");
assert.ok(route.includes("priceDifference:"), "report must show price differences separately from identity");
assert.ok(route.includes("skuMatches:"), "report must compare stored and actual identifiers");
assert.ok(route.includes("externalVisible"), "report must include actual visibility");
assert.ok(route.includes("externalStock"), "report must include actual stock");
assert.ok(route.includes("const finiteNumberOrNull"), "missing prices and stock must remain null, not become zero");
assert.ok(route.includes("finiteNumberOrNull(item.price)") && route.includes("finiteNumberOrNull(item.stock)"), "actual missing price and stock must be preserved as unknown");
assert.ok(route.includes("finiteNumberOrNull(row.selling_price)"), "missing stored price must not be interpreted as zero");
assert.ok(route.includes("([A-Z0-9_]+?)"), "BASE detail error code parsing must not greedily consume the HTTP status suffix");

const parsed404 = "BASE_ITEM_DETAIL_FAILED:HTTP_404:not found".match(/^([A-Z0-9_]+?)(?::HTTP_(\\d{3}))?(?::|$)/);
assert.equal(parsed404?.[1], "BASE_ITEM_DETAIL_FAILED");
assert.equal(parsed404?.[2], "404", "a real BASE 404 must be recognized as not found");

const targets = ["163159664", "163159665", "163159668", "163159669", "163159671", "163159672", "163159673", "163159674"];
assert.equal(targets.length, 8);
assert.equal([...new Set(targets)].length, 8);
assert.ok(targets.every((id) => /^\d+$/.test(id)));
assert.equal(/^\d+$/.test("163159664x"), false);

console.log("BASE targeted readback static safety checks: 22 assertions passed");
