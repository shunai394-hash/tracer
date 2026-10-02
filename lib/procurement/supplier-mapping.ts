import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

type MappingStatus = {
  fullyAutomatable: boolean;
  reason: string;
  mappingId: string | null;
  supplierListingId: string | null;
  supplierAccountId: string | null;
  supplierCode: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
};

export async function getSupplierMappingStatus(
  db: SupabaseClient,
  shopListingId: string,
): Promise<MappingStatus> {
  const { data, error } = await db
    .from("supplier_product_mapping_status")
    .select(
      "id,supplier_listing_id,supplier_account_id,supplier_code,supplier_product_id,supplier_variant_id,fully_automatable,auto_order_enabled,auto_payment_enabled,auto_tracking_enabled,automation_status,mapping_verification_status",
    )
    .eq("shop_listing_id", shopListingId)
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      fullyAutomatable: false,
      reason: `mapping_lookup_failed:${error.message}`,
      mappingId: null,
      supplierListingId: null,
      supplierAccountId: null,
      supplierCode: null,
      supplierProductId: null,
      supplierVariantId: null,
    };
  }

  if (!data) {
    return {
      fullyAutomatable: false,
      reason: "fixed_supplier_mapping_missing",
      mappingId: null,
      supplierListingId: null,
      supplierAccountId: null,
      supplierCode: null,
      supplierProductId: null,
      supplierVariantId: null,
    };
  }

  if (data.fully_automatable === true) {
    return {
      fullyAutomatable: true,
      reason: "fully_automatable",
      mappingId: String(data.id),
      supplierListingId: String(data.supplier_listing_id),
      supplierAccountId: data.supplier_account_id ? String(data.supplier_account_id) : null,
      supplierCode: data.supplier_code ? String(data.supplier_code) : null,
      supplierProductId: data.supplier_product_id ? String(data.supplier_product_id) : null,
      supplierVariantId: data.supplier_variant_id ? String(data.supplier_variant_id) : null,
    };
  }

  const reasons: string[] = [];
  if (data.auto_order_enabled !== true) reasons.push("auto_order_disabled");
  if (data.auto_payment_enabled !== true) reasons.push("auto_payment_disabled");
  if (data.auto_tracking_enabled !== true) reasons.push("auto_tracking_disabled");
  if (data.automation_status !== "eligible") reasons.push(`automation_status_${data.automation_status ?? "unknown"}`);
  if (data.mapping_verification_status !== "verified") reasons.push(`mapping_verification_${data.mapping_verification_status ?? "unknown"}`);

  return {
    fullyAutomatable: false,
    reason: reasons.join("|") || "supplier_mapping_capability_not_verified",
    mappingId: String(data.id),
    supplierListingId: String(data.supplier_listing_id),
    supplierAccountId: data.supplier_account_id ? String(data.supplier_account_id) : null,
    supplierCode: data.supplier_code ? String(data.supplier_code) : null,
    supplierProductId: data.supplier_product_id ? String(data.supplier_product_id) : null,
    supplierVariantId: data.supplier_variant_id ? String(data.supplier_variant_id) : null,
  };
}
