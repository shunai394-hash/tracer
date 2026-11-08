import type { FishAudioPublicVoice } from "@/lib/ai-live/fish-audio-public-voices";

const MODEL_LIST_URL = "https://api.fish.audio/model";
const DRAMA_CLONE_TAG = "tracer-drama-clone";

/** Lists private, adult-speaker clone models created through TRACER's consent-gated clone endpoint. */
export async function listPrivateDramaCloneVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const url = new URL(MODEL_LIST_URL);
  url.searchParams.set("self", "true");
  url.searchParams.set("tag", DRAMA_CLONE_TAG);
  url.searchParams.set("page_size", "100");
  url.searchParams.set("page_number", "1");
  url.searchParams.set("sort_by", "created_at");

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("fish_audio_private_drama_clones_unavailable");

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("fish_audio_private_drama_clones_invalid_response");
  }

  return (payload as { items: unknown[] }).items.flatMap((item): FishAudioPublicVoice[] => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model._id === "string" ? model._id : "";
    const title = typeof model.title === "string" ? model.title.trim() : "";
    const tags = Array.isArray(model.tags) ? model.tags.filter((value): value is string => typeof value === "string") : [];
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !title || model.type !== "tts" || model.visibility !== "private" || !tags.includes(DRAMA_CLONE_TAG)) return [];
    return [{
      id,
      title: title.slice(0, 100),
      description: typeof model.description === "string" ? model.description.slice(0, 300) : "本人許可確認済みの非公開ドラマ用クローン音声",
      languages: ["ja"],
      tags: ["本人許可確認済み", "カスタムクローン", "非公開"],
    }];
  });
}
