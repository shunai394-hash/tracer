import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const VOICE_DESIGN_URL = "https://api.fish.audio/v1/voice-design";
const MODEL_URL = "https://api.fish.audio/model";
const MAX_PREVIEW_TEXT = 150;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 105_000;

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

/**
 * Generate an original fictional child-character voice from text instructions.
 * No child recording, personal data, or real-person reference is accepted.
 * The preview is converted into a private reusable TTS model, tagged for
 * server-side allowlisting in the drama studio.
 */
export async function POST(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: "fish_audio_not_configured", missing: ["FISH_AUDIO_API_KEY"] }, 503);
  }

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "invalid_json_object" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  const referenceText = typeof input.referenceText === "string" ? input.referenceText.trim() : "こんにちは！ぼくもいっしょに行きたい！";
  const title = typeof input.title === "string" ? input.title.trim() : "TRACER 子供役（架空音声）";
  if (!instruction || instruction.length > 2000) {
    return json({ ok: false, error: "instruction_length_out_of_range", minCharacters: 1, maxCharacters: 2000 }, 400);
  }
  if (!referenceText || referenceText.length > MAX_PREVIEW_TEXT) {
    return json({ ok: false, error: "reference_text_length_out_of_range", maxCharacters: MAX_PREVIEW_TEXT }, 400);
  }
  if (!title || title.length > 80) {
    return json({ ok: false, error: "invalid_title", maxCharacters: 80 }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const designResponse = await fetch(VOICE_DESIGN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: "voice-design-1",
      },
      body: JSON.stringify({
        instruction,
        reference_text: referenceText,
        language: "ja",
        n: 1,
        speed: 1,
        num_step: 32,
        guidance_scale: 2,
        instruct_guidance_scale: 0,
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!designResponse.ok) {
      return json({
        ok: false,
        error: "fish_audio_voice_design_rejected",
        providerStatus: designResponse.status,
        message: "Fish Audio did not create a voice candidate. No retry was made.",
      }, 502);
    }

    const designPayload: unknown = await designResponse.json();
    const candidates = designPayload && typeof designPayload === "object"
      ? (designPayload as Record<string, unknown>).candidates
      : null;
    const candidate = Array.isArray(candidates) ? candidates[0] : null;
    if (!candidate || typeof candidate !== "object") {
      return json({ ok: false, error: "fish_audio_voice_design_candidate_missing" }, 502);
    }
    const candidateData = candidate as Record<string, unknown>;
    const audioBase64 = typeof candidateData.audio_base64 === "string" ? candidateData.audio_base64 : "";
    const signature = typeof candidateData.id === "string" ? candidateData.id : "";
    if (!audioBase64 || !signature || !/^[a-zA-Z0-9_-]{8,256}$/.test(signature)) {
      return json({ ok: false, error: "fish_audio_voice_design_candidate_invalid" }, 502);
    }

    const audioBytes = Buffer.from(audioBase64, "base64");
    if (!audioBytes.byteLength || audioBytes.byteLength > MAX_AUDIO_BYTES) {
      return json({ ok: false, error: "voice_design_audio_size_out_of_range", maxBytes: MAX_AUDIO_BYTES }, 502);
    }

    const modelForm = new FormData();
    modelForm.set("type", "tts");
    modelForm.set("title", title);
    modelForm.set("description", "TRACER用に文章から生成した架空の子供役音声。実在する子供の録音・声の模倣は使用していません。");
    modelForm.set("visibility", "private");
    modelForm.set("train_mode", "fast");
    modelForm.set("enhance_audio_quality", "true");
    const audioArrayBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioArrayBuffer).set(audioBytes);
    modelForm.append("voices", new Blob([audioArrayBuffer], { type: "audio/wav" }), "tracer-fictional-child-voice.wav");
    modelForm.set("texts", referenceText);
    modelForm.append("tags", "ja");
    modelForm.append("tags", "tracer-drama-child");

    const modelResponse = await fetch(MODEL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: modelForm,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!modelResponse.ok) {
      return json({
        ok: false,
        error: "fish_audio_private_voice_model_rejected",
        providerStatus: modelResponse.status,
        message: "Voice design succeeded, but private model registration failed. No retry was made.",
      }, 502);
    }

    const modelPayload: unknown = await modelResponse.json();
    if (!modelPayload || typeof modelPayload !== "object" || Array.isArray(modelPayload)) {
      return json({ ok: false, error: "fish_audio_private_voice_model_response_invalid" }, 502);
    }
    const model = modelPayload as Record<string, unknown>;
    const modelId = typeof model._id === "string" ? model._id : typeof model.id === "string" ? model.id : "";
    if (!modelId) return json({ ok: false, error: "fish_audio_private_voice_model_id_missing" }, 502);

    return json({
      ok: true,
      modelId,
      title: typeof model.title === "string" ? model.title : title,
      visibility: "private",
      source: "voice_design",
      category: "child_character",
      message: "架空の子供役ボイスを作成しました。音声一覧を再読み込みして選択できます。",
    }, 201);
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error && error.name === "AbortError" ? "fish_audio_voice_design_timeout" : "fish_audio_voice_design_unavailable",
      message: "Fish Audioの音声設計を完了できませんでした。自動再試行はしていません。",
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
