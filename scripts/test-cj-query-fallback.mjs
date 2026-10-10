import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deterministicCJProductQueries } from "../lib/intelligence/deterministic-cj-product-queries.ts";

assert.deepEqual(deterministicCJProductQueries("  H-shaped travel neck pillow  "), ["H-shaped travel neck pillow"]);
assert.deepEqual(deterministicCJProductQueries("   "), []);
assert.deepEqual(deterministicCJProductQueries("Toyota Prius car seat cover"), ["Toyota Prius car seat cover"]);
const source = await readFile(new URL("../lib/intelligence/generate-cj-product-queries.ts", import.meta.url), "utf8");
assert.match(source, /if\s*\(!isGeminiConfigured\(\)\)\s*return deterministicCJProductQueries\(demandQuery\)/);
const pipelineSource = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.match(pipelineSource, /\.in\("status",\s*\["new",\s*"researching"\]\)/);
console.log("CJ query fallback tests: 5 assertions passed");
