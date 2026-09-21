import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type EvidenceClass = "actual" | "estimated" | "unknown";

export async function writeEvidence(args: {
  productId?: string | null;
  bestsellerId?: string | null;
  supplierListingId?: string | null;
  source: string;
  url?: string | null;
  fetchedAt: string;
  fieldName: string;
  fieldValue: string | null;
  evidenceClass: EvidenceClass;
  confidence: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("evidence_ledger").insert({
    product_id: args.productId ?? null,
    bestseller_id: args.bestsellerId ?? null,
    supplier_listing_id: args.supplierListingId ?? null,
    source: args.source,
    url: args.url ?? null,
    fetched_at: args.fetchedAt,
    field_name: args.fieldName,
    field_value: args.fieldValue,
    evidence_class: args.evidenceClass,
    confidence: args.confidence,
    metadata: args.metadata ?? {},
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function listEvidenceForProduct(productId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("evidence_ledger")
    .select("*")
    .eq("product_id", productId)
    .order("fetched_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(error.message);
  return data ?? [];
}
