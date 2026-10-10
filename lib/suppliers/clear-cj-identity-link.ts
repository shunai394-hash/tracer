import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminDb = ReturnType<typeof createSupabaseAdminClient>;

export type CjIdentityLinkReset = {
  reason: string;
  retryDelayMs: number;
  checkedAt: Date;
  variantBarcode: string | null;
  barcodeAudit: {
    variant_barcode_raw: string | null;
    variant_barcode_validation: "missing" | "valid_gs1_check_digit" | "invalid_format_or_check_digit";
  };
};

/** Clear prior canonical identity evidence before retrying a failed CJ re-verification. */
export async function clearCjIdentityLinkOnFailure(
  db: AdminDb,
  supplierListingId: string,
  fallbackMetadata: Record<string, unknown>,
  options: CjIdentityLinkReset,
): Promise<void> {
  const { data: latest, error: readError } = await db
    .from("supplier_listings")
    .select("metadata")
    .eq("id", supplierListingId)
    .maybeSingle();
  if (readError) throw new Error(`CJ identity reset metadata read failed: ${readError.message}`);

  const currentMetadata = latest?.metadata && typeof latest.metadata === "object" && !Array.isArray(latest.metadata)
    ? latest.metadata as Record<string, unknown>
    : fallbackMetadata;
  const checkedAt = options.checkedAt;
  const metadata = {
    ...currentMetadata,
    marketplace_variant_evidence_id: null,
    marketplace_source_variant_id: null,
    identity_source: "cj_variant_evidence",
    identity_rationale: options.reason,
    identity_hold_reason: options.reason,
    variant_barcode: options.variantBarcode,
    ...options.barcodeAudit,
    last_identity_reverify_at: checkedAt.toISOString(),
    next_identity_reverify_at: new Date(checkedAt.getTime() + options.retryDelayMs).toISOString(),
  };

  const { error } = await db.from("supplier_listings").update({
    bestseller_id: null,
    product_id: null,
    identity_method: "supply_discovered",
    identity_status: "unverified",
    identity_confidence: 0,
    orderable: false,
    api_available: false,
    tracking_available: false,
    verification_status: "retryable",
    metadata,
  }).eq("id", supplierListingId);
  if (error) throw new Error(`CJ identity reset failed: ${error.message}`);
}
