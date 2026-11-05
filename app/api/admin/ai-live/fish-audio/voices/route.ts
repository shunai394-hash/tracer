import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { listLicensedJapaneseVoices } from "@/lib/ai-live/fish-audio-public-voices";
import { getConsentedCustomJapaneseVoices } from "@/lib/ai-live/fish-audio-consented-custom-voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function GET(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: "fish_audio_not_configured", message: "FISH_AUDIO_API_KEY is not configured." }, 503);
  }

  try {
    const publicVoices = await listLicensedJapaneseVoices(apiKey);
    const customVoices = getConsentedCustomJapaneseVoices();
    const voices = [...publicVoices.map((voice) => ({ ...voice, source: "public_licensed" as const })), ...customVoices];
    return json({ ok: true, voices, count: voices.length, publicLicensedCount: publicVoices.length, consentedCustomCount: customVoices.length, language: "ja" });
  } catch {
    return json({
      ok: false,
      error: "fish_audio_voice_library_unavailable",
      message: "The licensed Japanese voice list could not be loaded. No TTS generation was requested.",
    }, 502);
  }
}
