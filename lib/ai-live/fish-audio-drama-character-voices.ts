import type { FishAudioPublicVoice } from "@/lib/ai-live/fish-audio-public-voices";

const MODEL_LIST_URL = "https://api.fish.audio/model";

/** Exact Fish Audio model IDs explicitly assigned by the account owner to drama characters. */
export const TRACER_DRAMA_CHARACTER_VOICES = [
  { id: "7478a76f38974bd2afa89c1bbe6831c7", title: "蒼真", gender: "男性" },
  { id: "160840e5c583459d89dc5521e7f175e5", title: "美月", gender: "女性" },
] as const;

export async function listTracerDramaCharacterVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const url = new URL(MODEL_LIST_URL);
  url.searchParams.set("self", "true");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("page_number", "1");
  url.searchParams.set("sort_by", "created_at");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("fish_audio_owned_models_unavailable");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("fish_audio_owned_models_invalid_response");
  }
  const models = (payload as { items: unknown[] }).items;
  return TRACER_DRAMA_CHARACTER_VOICES.flatMap((preset): FishAudioPublicVoice[] => {
    const model = models.find((item) => item && typeof item === "object" && (item as Record<string, unknown>)._id === preset.id) as Record<string, unknown> | undefined;
    if (!model || model.type !== "tts") return [];
    return [{
      id: preset.id,
      title: preset.title,
      description: `${preset.gender}・TRACERショートドラマ登録ボイス`,
      languages: ["ja"],
      tags: ["TRACERドラマ", preset.gender, "登録済みモデル"],
    }];
  });
}

export async function isTracerDramaCharacterVoice(apiKey: string, referenceId: string): Promise<boolean> {
  if (!TRACER_DRAMA_CHARACTER_VOICES.some((voice) => voice.id === referenceId)) return false;
  const voices = await listTracerDramaCharacterVoices(apiKey);
  return voices.some((voice) => voice.id === referenceId);
}
