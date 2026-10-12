import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../lib/config/env.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

assert.match(env, /readEnv\("GEMINI_MODEL"\)\s*\|\|\s*"gemini-3\.8-flash"/,
  "unset GEMINI_MODEL must use the supported model identified by current production API errors");
assert.doesNotMatch(env, /\|\|\s*"gemini-2\.5-flash"/,
  "do not default to the retired gemini-2.5-flash model");
assert.match(readme, /defaults to `gemini-3\.8-flash`/,
  "document the actual fallback model");
console.log("Gemini model default: supported fallback configured");
