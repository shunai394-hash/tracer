import assert from "node:assert/strict";

import { getGeminiConfig } from "../lib/config/env.ts";

const originalApiKey = process.env.GEMINI_API_KEY;
const originalModel = process.env.GEMINI_MODEL;

try {
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;

  assert.deepEqual(getGeminiConfig(), {
    apiKey: "test-key",
    model: "gemini-3.8-flash",
  });

  process.env.GEMINI_MODEL = "  custom-gemini-model  ";
  assert.deepEqual(getGeminiConfig(), {
    apiKey: "test-key",
    model: "custom-gemini-model",
  });

  console.log("Gemini model default and environment override: PASS");
} finally {
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;

  if (originalModel === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = originalModel;
}
