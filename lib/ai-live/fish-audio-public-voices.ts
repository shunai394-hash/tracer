export type FishAudioPublicVoice = {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
};

const MODEL_LIST_URL = "https://api.fish.audio/model";

function isJapaneseLanguage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "ja" || normalized === "japanese" || normalized === "日本語";
}

export async function listLicensedJapaneseVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const url = new URL(MODEL_LIST_URL);
  url.searchParams.set("language", "ja");
  url.searchParams.set("licensed", "true");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("page_number", "1");
  url.searchParams.set("sort_by", "score");

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("fish_audio_voice_library_unavailable");

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("fish_audio_voice_library_invalid_response");
  }

  return ((payload as { items: unknown[] }).items).flatMap((item): FishAudioPublicVoice[] => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model._id === "string" ? model._id : "";
    const title = typeof model.title === "string" ? model.title.trim() : "";
    const visibility = typeof model.visibility === "string" ? model.visibility : "";
    const languages = Array.isArray(model.languages)
      ? model.languages.filter((value): value is string => typeof value === "string")
      : [];
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !title || visibility !== "public" || !languages.some(isJapaneseLanguage)) {
      return [];
    }
    const tags = Array.isArray(model.tags)
      ? model.tags.filter((value): value is string => typeof value === "string").slice(0, 12)
      : [];
    return [{
      id,
      title: title.slice(0, 100),
      description: typeof model.description === "string" ? model.description.slice(0, 300) : "",
      languages,
      tags,
    }];
  });
}
