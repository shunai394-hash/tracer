export type FishAudioPublicVoice = {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
};

const MODEL_LIST_URL = "https://api.fish.audio/model";
const PAGE_SIZE = 100;
const MAX_PUBLIC_MODELS = 1000;

function isJapaneseLanguage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "ja" || normalized === "japanese" || normalized === "日本語";
}

type ModelPage = { total?: number; items?: unknown[] };

async function fetchLicensedPage(apiKey: string, pageNumber: number): Promise<ModelPage> {
  const url = new URL(MODEL_LIST_URL);
  url.searchParams.set("language", "ja");
  url.searchParams.set("licensed", "true");
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("page_number", String(pageNumber));
  url.searchParams.set("sort_by", "score");

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("fish_audio_voice_library_unavailable");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as ModelPage).items)) {
    throw new Error("fish_audio_voice_library_invalid_response");
  }
  return payload as ModelPage;
}

function normalizeVoices(items: unknown[]): FishAudioPublicVoice[] {
  return items.flatMap((item): FishAudioPublicVoice[] => {
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

/** Return the full first 1,000 licensed Japanese public voices, not only page 1. */
export async function listLicensedJapaneseVoices(apiKey: string): Promise<FishAudioPublicVoice[]> {
  const firstPage = await fetchLicensedPage(apiKey, 1);
  const firstItems = firstPage.items ?? [];
  const total = typeof firstPage.total === "number" && Number.isFinite(firstPage.total)
    ? Math.max(0, firstPage.total)
    : firstItems.length;
  const pageCount = Math.min(Math.ceil(Math.min(total, MAX_PUBLIC_MODELS) / PAGE_SIZE), 10);
  const remainingPages = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
  const pages = await Promise.all(remainingPages.map((page) => fetchLicensedPage(apiKey, page)));
  const allItems = [...firstItems, ...pages.flatMap((page) => page.items ?? [])];
  const unique = new Map<string, FishAudioPublicVoice>();
  for (const voice of normalizeVoices(allItems)) {
    if (!unique.has(voice.id)) unique.set(voice.id, voice);
  }
  return [...unique.values()];
}
