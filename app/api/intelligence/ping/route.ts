import {
  GeminiConfigError,
  GeminiRequestError,
  GeminiTimeoutError,
} from "@/lib/ai/gemini";
import { pingIntelligenceLayer } from "@/lib/intelligence";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await pingIntelligenceLayer();
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    if (error instanceof GeminiConfigError) {
      return Response.json(
        { ok: false, message: "Gemini is not configured" },
        { status: 503 },
      );
    }
    if (error instanceof GeminiTimeoutError) {
      return Response.json(
        { ok: false, message: "Gemini request timed out" },
        { status: 504 },
      );
    }
    if (error instanceof GeminiRequestError) {
      return Response.json(
        { ok: false, message: "Gemini request failed" },
        { status: 502 },
      );
    }
    return Response.json(
      { ok: false, message: "Intelligence layer unavailable" },
      { status: 500 },
    );
  }
}
