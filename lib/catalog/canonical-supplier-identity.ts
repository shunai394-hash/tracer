import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Returns only supplier listings whose canonical identity review is explicitly linked. */
export async function getLinkedSupplierListingIds(values: unknown[]): Promise<Set<string>> {
  const ids = [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  if (ids.length === 0) return new Set();

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("supplier_listings")
    .select("id,identity_status")
    .in("id", ids);
  if (error) throw new Error(`supplier_identity_lookup_failed:${error.message}`);
  return new Set((data ?? []).filter((row) => row.identity_status === "linked").map((row) => String(row.id)));
}
