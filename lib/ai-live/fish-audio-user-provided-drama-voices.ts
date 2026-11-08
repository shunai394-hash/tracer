import type { FishAudioPublicVoice } from "@/lib/ai-live/fish-audio-public-voices";

const USER_PROVIDED_DRAMA_VOICES = [
  { id: "7478a76f38974bd2afa89c1bbe6831c7", title: "蒼真" },
  { id: "160840e5c583459d89dc5521e7f175e5", title: "美月" },
] as const;
const MODEL_URL = "https://api.fish.audio/model/";

/** Verify explicitly supplied model IDs against Fish Audio before exposing them to TTS. */
export async function listUserProvidedDramaVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const results = await Promise.all(USER_PROVIDED_DRAMA_VOICES.map(async (entry) => {
    const response = await fetch(new URL(encodeURIComponent(entry.id), MODEL_URL), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const model: unknown = await response.json();
    if (!model || typeof model !== "object") return null;
    const value = model as Record<string, unknown>;
    const languages = Array.isArray(value.languages) ? value.languages.filter((v): v is string => typeof v === "string") : [];
    const state = typeof value.state === "string" ? value.state : "";
    if (value._id !== entry.id || value.type !== "tts" || state !== "trained" || !languages.some((v) => ["ja", "japanese", "日本語"].includes(v.toLowerCase()))) return null;
    return {
      id: entry.id,
      title: entry.title,
      description: "ユーザー指定のFish AudioモデルID。Fish Audio APIで利用可能性を確認済み。",
      languages,
      tags: ["ドラマ", "ユーザー指定モデル"],
    } satisfies FishAudioPublicVoice;
  }));
  return results.filter((voice): voice is FishAudioPublicVoice => voice !== null);
}

export function isUserProvidedDramaVoice(referenceId: string): boolean {
  return USER_PROVIDED_DRAMA_VOICES.some((voice) => voice.id === referenceId);
}
