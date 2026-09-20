import "server-only";

import { generateStructuredJson } from "@/lib/ai/gemini/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `gemini:${Math.abs(hash).toString(16)}:${value.length}`;
}

export async function generateCachedStructuredJson<T>(args: {
  cacheKey: string;
  prompt: string;
  systemInstruction?: string;
  timeoutMs?: number;
}): Promise<T> {
  const key = hashKey(args.cacheKey);

  try {
    const supabase = createSupabaseAdminClient();
    const cached = await supabase
      .from("intelligence_gemini_cache")
      .select("payload")
      .eq("cache_key", key)
      .maybeSingle();

    if (!cached.error && cached.data?.payload) {
      return cached.data.payload as T;
    }
  } catch {
    // Cache is optional. Continue without it.
  }

  const result = await generateStructuredJson<T>({
    prompt: args.prompt,
    systemInstruction: args.systemInstruction,
    timeoutMs: args.timeoutMs,
  });

  try {
    const supabase = createSupabaseAdminClient();
    await supabase.from("intelligence_gemini_cache").upsert(
      {
        cache_key: key,
        payload: result,
        created_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" },
    );
  } catch {
    // Cache write is optional.
  }

  return result;
}
