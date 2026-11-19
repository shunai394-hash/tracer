import { createHash } from "node:crypto";
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type SupplierFact = {
  supplierConfirmed: boolean;
  supplierFingerprint: string | null;
};

/**
 * Read-only supplier confirmation for the AI live worker.
 * The raw supplier identifiers stay in this process. Callers receive a
 * confirmation flag and a short fingerprint so a mismatch can stop an
 * introduction without copying those identifiers into logs or the worker state.
 */
export async function supplierFactsByListingId(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, SupplierFact>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 20);
  const facts = new Map<string, SupplierFact>();
  if (unique.length === 0) return facts;

  const { data, error } = await db
    .from("shop_listings")
    .select("id,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id")
    .in("id", unique);
  if (error) throw new Error("ai_live_product_read_failed");

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const parts = [row.supplier_name, row.supplier_listing_id, row.supplier_product_id, row.supplier_variant_id];
    const confirmed = parts.every((part) => typeof part === "string" && part.trim().length > 0);
    facts.set(id, {
      supplierConfirmed: confirmed,
      supplierFingerprint: confirmed
        ? createHash("sha256").update(parts.map((part) => String(part).trim()).join("\n")).digest("hex").slice(0, 32)
        : null,
    });
  }
  return facts;
}
