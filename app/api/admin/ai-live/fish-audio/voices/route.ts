import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { listLicensedJapaneseVoices } from "@/lib/ai-live/fish-audio-public-voices";
import { getConsentedCustomJapaneseVoices } from "@/lib/ai-live/fish-audio-consented-custom-voices";
import { listPrivateDramaChildVoices } from "@/lib/ai-live/fish-audio-private-drama-voices";
import { listPrivateDramaCloneVoices } from "@/lib/ai-live/fish-audio-private-drama-clone-voices";
import { listTracerDramaCharacterVoices, resolveFishAudioModelVoice } from "@/lib/ai-live/fish-audio-drama-character-voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

  let registeredVoices: Array<{ id: string; title: string; description: string; languages: string[]; tags: string[]; source: "id_registered" }> = [];
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("fish_audio_registered_voices").select("model_id,title,metadata").order("updated_at", { ascending: false });
    if (error) throw error;
    registeredVoices = (data ?? []).map((row) => ({
      id: row.model_id,
      title: row.title,
      description: "TRACER共通登録・Fish Audio ID照合済み",
      languages: ["ja"],
      tags: ["Fish Audio登録モデル", "TRACER共通登録"],
      source: "id_registered" as const,
    }));
  } catch {
    return json({ ok: false, error: "voice_registry_unavailable", message: "TRACER共通ボイス台帳を読み込めません。管理者に連絡してください。" }, 503);
  }

  const customVoices = getConsentedCustomJapaneseVoices();
  let publicVoices: Awaited<ReturnType<typeof listLicensedJapaneseVoices>> = [];
  let publicLibraryAvailable = true;
  let privateChildVoices: Awaited<ReturnType<typeof listPrivateDramaChildVoices>> = [];
  let privateCloneVoices: Awaited<ReturnType<typeof listPrivateDramaCloneVoices>> = [];
  let dramaCharacterVoices: Awaited<ReturnType<typeof listTracerDramaCharacterVoices>> = [];
  let privateChildLibraryAvailable = true;
  const [publicResult, privateChildResult, privateCloneResult, dramaCharacterResult] = await Promise.allSettled([
    listLicensedJapaneseVoices(apiKey),
    listPrivateDramaChildVoices(apiKey),
    listPrivateDramaCloneVoices(apiKey),
    listTracerDramaCharacterVoices(apiKey),
  ]);
  if (publicResult.status === "fulfilled") {
    publicVoices = publicResult.value;
  } else {
    publicLibraryAvailable = false;
  }
  if (privateChildResult.status === "fulfilled") {
    privateChildVoices = privateChildResult.value;
  } else {
    privateChildLibraryAvailable = false;
  }
  if (privateCloneResult.status === "fulfilled") {
    privateCloneVoices = privateCloneResult.value;
  }
  if (dramaCharacterResult.status === "fulfilled") {
    dramaCharacterVoices = dramaCharacterResult.value;
  }
  const voices = [
    ...publicVoices.map((voice) => ({ ...voice, source: "public_licensed" as const })),
    ...registeredVoices,
    ...customVoices,
    ...privateCloneVoices.map((voice) => ({ ...voice, source: "user_provided_clone" as const, consentStatus: "confirmed" as const })),
    ...dramaCharacterVoices.filter((voice) => !registeredVoices.some((registered) => registered.id === voice.id)).map((voice) => ({ ...voice, source: "private_drama_character" as const })),
    ...privateChildVoices.map((voice) => ({ ...voice, source: "private_voice_design" as const })),
  ];
  return json({
    ok: true,
    voices,
    count: voices.length,
    publicLicensedCount: publicVoices.length,
    consentedCustomCount: customVoices.length,
    privateChildVoiceCount: privateChildVoices.length,
    privateDramaCloneCount: privateCloneVoices.length,
    dramaCharacterVoiceCount: dramaCharacterVoices.length,
    privateChildLibraryAvailable,
    publicLibraryAvailable,
    language: "ja",
  });
}


/** Verify and register a user-supplied Fish Audio TTS model ID. */
export async function POST(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) return json({ ok: false, error: "fish_audio_not_configured", message: "FISH_AUDIO_API_KEY is not configured." }, 503);
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ ok: false, error: "invalid_json_object" }, 400);
    input = parsed as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !title || title.length > 60) {
    return json({ ok: false, error: "invalid_voice_registration", message: "モデルIDと60文字以内の表示名を入力してください。" }, 400);
  }
  try {
    const voice = await resolveFishAudioModelVoice(apiKey, id, title);
    if (!voice) return json({ ok: false, error: "fish_audio_model_not_accessible", message: "このIDのTTSモデルをFish Audioアカウントから確認できません。IDとAPIキーのアカウントを確認してください。" }, 404);
    const db = createSupabaseAdminClient();
    const { error: saveError } = await db.from("fish_audio_registered_voices").upsert({
      model_id: id,
      title: title.trim(),
      model_type: "tts",
      model_state: "verified",
      metadata: { verified_by: "fish_audio_model_api", language: "ja" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "model_id" });
    if (saveError) {
      return json({ ok: false, error: "voice_registry_save_failed", message: "Fish Audioでの照合は成功しましたが、TRACER共通台帳への保存に失敗しました。登録完了にはなっていません。" }, 503);
    }
    return json({ ok: true, voice: { ...voice, source: "id_registered" } });
  } catch {
    return json({ ok: false, error: "fish_audio_model_lookup_unavailable", message: "Fish Audioへのモデル照会に失敗しました。時間をおいて再試行してください。" }, 502);
  }
}
