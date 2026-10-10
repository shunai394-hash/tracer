// Test double for "@/lib/supabase/admin": returns the in-memory database the
// test installed. Never creates a real client.
export function createSupabaseAdminClient() {
  if (!globalThis.__TRACER_MEMORY_DB__) throw new Error("test did not install __TRACER_MEMORY_DB__");
  return globalThis.__TRACER_MEMORY_DB__;
}
