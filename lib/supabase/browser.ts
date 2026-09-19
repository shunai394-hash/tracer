import { createClient } from "@supabase/supabase-js";

/**
 * Browser client uses the anon key only.
 * Never import the admin client from Client Components.
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase public credentials are not configured");
  }

  return createClient(url, anonKey);
}
