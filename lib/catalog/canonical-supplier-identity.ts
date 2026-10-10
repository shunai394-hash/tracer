import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Returns only supplier listings whose canonical identity review is explicitly linked. */
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
      .select("id,identity_status")
      .in("id", batch);
    if (error) throw new Error(`supplier_identity_lookup_failed:${error.message}`);
    for (const row of data ?? []) {
      if (row.identity_status === "linked") linked.add(String(row.id));
    }
  }
  return linked;
}
