import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../lib/config/env.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// The fallback and legacy explicit value must both resolve to the supported model.
assert.match(
  env,
  /!configuredModel\s*\|\|\s*configuredModel\s*===\s*"gemini-2\.5-flash"[\s\S]{0,120}\?\s*"gemini-3\.8-flash"/,
  "unset and legacy GEMINI_MODEL values must migrate to gemini-3.8-flash",
);
assert.match(
  env,
  /:\s*configuredModel\s*;/,
  "non-legacy explicit GEMINI_MODEL overrides must be preserved",
);
assert.match(readme, /defaults to `gemini-3\.8-flash`/, "document the actual fallback model");
assert.match(readme, /legacy `gemini-2\.5-flash` values are migrated/, "document legacy override migration");

console.log("Gemini model configuration regression checks passed");
