import assert from "node:assert/strict";
import { deterministicCJProductQueries, generateCJProductQueries } from "../lib/intelligence/generate-cj-product-queries.ts";

// This test deliberately exercises the no-Gemini path without making network calls.
process.env.GEMINI_API_KEY = "";
assert.deepEqual(deterministicCJProductQueries("  H-shaped travel neck pillow  ", "travel accessories"), ["H-shaped travel neck pillow"]);
assert.deepEqual(deterministicCJProductQueries("   ", null), []);
assert.deepEqual(deterministicCJProductQueries("Toyota Prius car seat cover", "automotive"), ["Toyota Prius car seat cover"]);
assert.deepEqual(await generateCJProductQueries("women's compact travel umbrella", "accessories"), ["women's compact travel umbrella"]);
console.log("CJ query fallback tests: 4 passed");
