import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/config/env";

export class SupabaseConfigError extends Error {
  readonly code = "SUPABASE_NOT_CONFIGURED" as const;

  constructor(message = "Supabase is not configured") {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabasePublicConfig();
  return Boolean(url && anonKey);
}

export function createSupabaseServerClient() {
  const { url, anonKey } = getSupabasePublicConfig();
  if (!url || !anonKey) {
    throw new SupabaseConfigError();
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
