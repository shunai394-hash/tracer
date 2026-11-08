import type { FishAudioPublicVoice } from "@/lib/ai-live/fish-audio-public-voices";

const MODEL_URL = "https://api.fish.audio/model";

/** Exact Fish Audio model IDs assigned by the account owner to drama characters. */
export const TRACER_DRAMA_CHARACTER_VOICES = [
  { id: "7478a76f38974bd2afa89c1bbe6831c7", title: "蓮司", gender: "男性" },
  { id: "160840e5c583459d89dc5521e7f175e5", title: "美月", gender: "女性" },
] as const;

/**
 * Resolve the two explicitly assigned IDs directly.
 * Do not rely on the first page of /model?self=true: accounts with more than
 * 100 models can have valid character models omitted from that page.
 */
export async function resolveFishAudioModelVoice(apiKey: string, modelId: string, title: string): Promise<FishAudioPublicVoice | null> {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(modelId) || !title.trim() || title.trim().length > 60) return null;
  const response = await fetch(`${MODEL_URL}/${encodeURIComponent(modelId)}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error("fish_audio_model_lookup_unavailable");
  const model: unknown = await response.json();
  if (!model || typeof model !== "object") return null;
  const record = model as Record<string, unknown>;
  if (record._id !== modelId || record.type !== "tts" || record.state === "failed") return null;
  return { id: modelId, title: title.trim(), description: "Fish Audio登録モデル・ID照合済み", languages: ["ja"], tags: ["Fish Audio登録モデル", "ID登録"] };
}

export async function listTracerDramaCharacterVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const results: Array<FishAudioPublicVoice | null> = await Promise.all(TRACER_DRAMA_CHARACTER_VOICES.map(async (preset): Promise<FishAudioPublicVoice | null> => {
    const resolved = await resolveFishAudioModelVoice(apiKey, preset.id, preset.title);
    return resolved ? { ...resolved, description: `${preset.gender}・TRACERショートドラマ登録ボイス`, tags: ["TRACERドラマ", preset.gender, "登録済みモデル"] } : null;
  }));
  return results.filter((voice) => voice !== null) as FishAudioPublicVoice[];
}

export async function isTracerDramaCharacterVoice(apiKey: string, referenceId: string): Promise<boolean> {
  if (!TRACER_DRAMA_CHARACTER_VOICES.some((voice) => voice.id === referenceId)) return false;
  const voices = await listTracerDramaCharacterVoices(apiKey);
  return voices.some((voice) => voice.id === referenceId);
}
