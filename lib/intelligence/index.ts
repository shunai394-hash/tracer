import "server-only";

import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini";

/**
 * Intelligence layer entry points.
 * Product scoring and discovery logic will live here later.
 */
export type IntelligencePing = {
  ok: boolean;
  layer: "gemini";
  message: string;
};

export async function pingIntelligenceLayer(): Promise<IntelligencePing> {
  if (!isGeminiConfigured()) {
    return {
      ok: false,
      layer: "gemini",
      message: "Gemini is not configured",
    };
  }

  const result = await generateStructuredJson<{ ok: boolean }>({
    systemInstruction:
      "You are TRACER's health check. Reply with JSON only: {\"ok\": true}.",
    prompt: "Confirm the intelligence layer is reachable.",
    timeoutMs: 12_000,
  });

  return {
    ok: result.ok === true,
    layer: "gemini",
    message: result.ok === true ? "Gemini responded" : "Gemini returned an unexpected payload",
  };
}
