import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deterministicCJProductQueries } from "../lib/intelligence/deterministic-cj-product-queries.ts";
import { normalizeCJProductDetailSummary, normalizeCJProductDetailVariants } from "../lib/sources/cj/product-detail-variants.ts";

assert.deepEqual(deterministicCJProductQueries("  H-shaped travel neck pillow  "), ["H-shaped travel neck pillow"]);
assert.deepEqual(deterministicCJProductQueries("   "), []);
assert.deepEqual(deterministicCJProductQueries("Toyota Prius car seat cover"), ["Toyota Prius car seat cover"]);
const source = await readFile(new URL("../lib/intelligence/generate-cj-product-queries.ts", import.meta.url), "utf8");
assert.match(source, /if\s*\(!isGeminiConfigured\(\)\)\s*return deterministicCJProductQueries\(demandQuery\)/);
assert.match(source, /catch\s*\(error\)/);
assert.match(source, /Gemini unavailable; using exact-query fallback/);
assert.match(source, /return deterministicCJProductQueries\(demandQuery\);/);
const pipelineSource = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.match(pipelineSource, /listedProductsNeedingIntelligence\(db,\s*20\)/, "listed products without intelligence must be prioritized");
assert.match(pipelineSource, /intelligenceBatchOffset/, "intelligence backlog must rotate across product pages");

const detailVariants = normalizeCJProductDetailVariants({
  result: true,
  data: {
    stanProducts: [
      { id: "vid-red", pid: "pid-a", sku: "SKU-RED", nameen: "Bag Red", img: "https://cdn.example/red.jpg,https://cdn.example/red-detail.jpg", sellprice: "12.50" },
      { id: "vid-blue", pid: "pid-a", sku: "SKU-BLUE", nameen: "Bag Blue", img: "https://cdn.example/blue.jpg", sellprice: "13.50" },
      { id: "vid-wrong-parent", pid: "pid-b", sku: "SKU-WRONG", img: "https://cdn.example/wrong.jpg" },
      { id: "vid-red", pid: "pid-a", sku: "SKU-DUP", img: "https://cdn.example/duplicate.jpg" },
      { id: "vid-no-image", pid: "pid-a", img: "not-a-url" },
    ],
  },
}, "pid-a");
assert.equal(detailVariants.length, 3, "only unique variants belonging to the requested CJ PID are retained");
assert.equal(detailVariants[0].vid, "vid-red");
assert.equal(detailVariants[0].variantImage, "https://cdn.example/red.jpg");
assert.equal(detailVariants[0].sku, "SKU-RED");
assert.equal(detailVariants[1].variantImage, "https://cdn.example/blue.jpg");
assert.equal(detailVariants[2].variantImage, null);
assert.deepEqual(normalizeCJProductDetailVariants({ result: false, data: {} }, "pid-a"), []);

const fullProduct = normalizeCJProductDetailSummary({
  result: true,
  data: {
    id: "pid-a",
    nameen: "Women's Shoulder Bag",
    sku: "CJ-BAG-SPU",
    sellprice: "7.80",
    bigimg: "https://cdn.example/parent.jpg",
    totalInventory: 1234,
    listed: 9,
    producttype: "4",
    saleStatus: "3",
  },
}, "pid-a");
assert.equal(fullProduct?.id, "pid-a");
assert.equal(fullProduct?.title, "Women's Shoulder Bag");
assert.equal(fullProduct?.imageUrl, "https://cdn.example/parent.jpg");
assert.equal(fullProduct?.inventory, 1234);
assert.equal(normalizeCJProductDetailSummary({
  result: true,
  data: { id: "pid-b", nameen: "Wrong product" },
}, "pid-a"), null);
assert.equal(normalizeCJProductDetailSummary({ result: false, data: {} }, "pid-a"), null);

const cjImporterSource = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
for (const pattern of [
  String.raw`[/\\bcoffee\\b/, "コーヒー色"]`,
  String.raw`[/large\\s+white/, "大・ホワイト"]`,
  String.raw`[/medium\\s+white/, "中・ホワイト"]`,
]) {
  assert.ok(cjImporterSource.includes(pattern), "CJ variant label regex must use real regex escapes: " + pattern);
}

for (const label of ["ピンクレオパード", "ホワイトフラワー", "カウ柄", "コーヒー色", "大・ホワイト", "中・ホワイト"]) {
  assert.ok(cjImporterSource.includes(label), "CJ variant label mapping missing: " + label);
}

const cjClientSource = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
assert.ok(cjClientSource.includes("/product/productDetail/query"));
assert.ok(cjClientSource.includes("detailByVid.get(vid)"));
assert.ok(cjClientSource.includes("normalizeCJProductDetailVariants(payload, pid)"));
assert.ok(cjClientSource.includes("return normalized ?? await queryCJProductDetailSummary(pid)"));

console.log("CJ query fallback and full product-detail variant image tests passed");
