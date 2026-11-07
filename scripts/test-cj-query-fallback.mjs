import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deterministicCJProductQueries } from "../lib/intelligence/deterministic-cj-product-queries.ts";
import { normalizeCJProductDetailVariants } from "../lib/sources/cj/product-detail-variants.ts";

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

const cjClientSource = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
assert.match(cjClientSource, /productDetail\\/query/);
assert.match(cjClientSource, /detailByVid\\.get\\(vid\\)/);
assert.match(cjClientSource, /normalizeCJProductDetailVariants\\(payload, pid\\)/);

console.log("CJ query fallback and full product-detail variant image tests passed");
