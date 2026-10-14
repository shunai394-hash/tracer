import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CJ_NATIVE_IDENTITY_METHOD, isCjNativeIdentityFresh } from "@/lib/procurement/cj-native-identity";

/**
 * Returns only supplier listings whose canonical identity review is explicitly
 * linked. A CJ-native proof counts only while its live check is fresh.
 */
export async function getLinkedSupplierListingIds(values: unknown[]): Promise<Set<string>> {
  const ids = [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  if (ids.length === 0) return new Set();

  const supabase = createSupabaseAdminClient();
  const linked = new Set<string>();
  // Keep PostgREST URLs comfortably below proxy/request-line limits when a
  // bounded catalog scan includes hundreds or thousands of supplier rows.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await supabase
      .from("supplier_listings")
      .select("id,identity_status,identity_method,cj_native_result:metadata->cj_native_identity->>result,cj_native_observed_at:metadata->cj_native_identity->>observed_at")
      .in("id", batch);
    if (error) throw new Error(`supplier_identity_lookup_failed:${error.message}`);
    const nowMs = Date.now();
    for (const row of data ?? []) {
      if (row.identity_status !== "linked") continue;
      // Freshness comes from the proof itself, not last_verified_at, which
      // other refresh jobs may advance without re-proving identity.
      if (row.identity_method === CJ_NATIVE_IDENTITY_METHOD
        && (row.cj_native_result !== "verified" || !isCjNativeIdentityFresh(row.cj_native_observed_at, nowMs))) continue;
      linked.add(String(row.id));
    }
  }
  return linked;
}
