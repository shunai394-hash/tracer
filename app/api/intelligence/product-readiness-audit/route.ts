import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Listing = {
  id: string;
  title: string | null;
  supplier_name: string | null;
  supplier_listing_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  selling_price: number | null;
  currency: string | null;
  inventory: number | null;
  orderable: boolean | null;
  published: boolean | null;
  base_item_id: string | null;
  base_publication_status: string | null;
  shopify_product_id: string | null;
  shopify_sync_status: string | null;
  pipeline_stage: string | null;
  pipeline_status: string | null;
  pipeline_reason: string | null;
  selection_reasons: unknown;
};

type SupplierEvidence = {
  id: string;
  identity_status: string | null;
  verification_status: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  orderable: boolean | null;
  inventory_confirmed: boolean | null;
  inventory: number | string | null;
  last_verified_at: string | null;
};

function blockers(row: Listing, supplierById: Map<string, SupplierEvidence>): string[] {
  const reasons: string[] = [];
  if (!row.supplier_listing_id) {
    reasons.push("supplier_listing_link_missing");
  } else {
    const supplier = supplierById.get(row.supplier_listing_id);
    if (!supplier) {
      reasons.push("supplier_listing_row_missing");
    } else {
      if (supplier.identity_status !== "linked") reasons.push("supplier_identity_not_linked");
      if (supplier.verification_status !== "verified") reasons.push("supplier_verification_not_verified");
      if (supplier.orderable !== true) reasons.push("supplier_orderability_not_verified");
      if (supplier.inventory_confirmed !== true) reasons.push("supplier_inventory_not_confirmed");
      const sourceInventory = Number(supplier.inventory);
      if (!Number.isFinite(sourceInventory) || sourceInventory <= 0) reasons.push("supplier_inventory_non_positive");
      if (!supplier.supplier_product_id) reasons.push("source_supplier_product_id_missing");
      if (!supplier.supplier_variant_id) reasons.push("source_supplier_variant_id_missing");
      if (row.supplier_product_id && supplier.supplier_product_id && row.supplier_product_id !== supplier.supplier_product_id) {
        reasons.push("supplier_product_id_mismatch");
      }
      if (row.supplier_variant_id && supplier.supplier_variant_id && row.supplier_variant_id !== supplier.supplier_variant_id) {
        reasons.push("supplier_variant_id_mismatch");
      }
    }
  }
  if (!row.supplier_product_id) reasons.push("supplier_product_id_missing");
  if (!row.supplier_variant_id) reasons.push("supplier_variant_id_missing");
  if (!Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) <= 0) reasons.push("selling_price_unknown_or_non_positive");
  if (row.currency !== "JPY") reasons.push("selling_currency_not_jpy");
  if (!Number.isFinite(Number(row.inventory)) || Number(row.inventory) <= 0) reasons.push("inventory_unknown_or_non_positive");
  if (row.orderable !== true) reasons.push("orderability_not_verified");
  if (!row.shopify_product_id || row.shopify_sync_status !== "synced") reasons.push("shopify_sync_not_verified");
  if (row.published === true && (!row.base_item_id || row.base_publication_status !== "published")) {
    reasons.push("base_publication_not_verified");
  }
  if (row.pipeline_status === "blocked") reasons.push(`pipeline_blocked:${row.pipeline_reason || "reason_unknown"}`);
  const normalizedTitle = String(row.title ?? "").trim().toLowerCase();
  if (!normalizedTitle || /^(暮らしの便利アイテム|便利アイテム|商品|product|item|general product)$/i.test(normalizedTitle)) {
    reasons.push("title_does_not_identify_concrete_product");
  }
  return reasons;
}

/**
 * Read-only product-level readiness report. It never publishes, edits, or
 * unpublishes listings; it exposes concrete blockers for the next repair pass.
 * A supplier row's existence alone is not proof of linked identity, live stock,
 * or orderability, so those source-side fields are independently checked.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("shop_listings")
    .select("id,title,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,selling_price,currency,inventory,orderable,published,base_item_id,base_publication_status,shopify_product_id,shopify_sync_status,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons")
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ ok: false, error: "shop_listings_read_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Listing[];
  const supplierIds = [...new Set(rows.map((row) => row.supplier_listing_id).filter((id): id is string => Boolean(id)))];
  const supplierById = new Map<string, SupplierEvidence>();
  if (supplierIds.length) {
    const { data: suppliers, error: supplierError } = await db
      .from("supplier_listings")
      .select("id,identity_status,verification_status,supplier_product_id,supplier_variant_id,orderable,inventory_confirmed,inventory,last_verified_at")
      .in("id", supplierIds);
    if (supplierError) {
      return NextResponse.json({ ok: false, error: "supplier_listing_link_check_failed" }, { status: 500 });
    }
    for (const supplier of (suppliers ?? []) as unknown as SupplierEvidence[]) {
      supplierById.set(String(supplier.id), supplier);
    }
  }

  const audited = rows.map((row) => {
    const reasons = blockers(row, supplierById);
    return {
      listingId: row.id,
      title: row.title,
      supplier: row.supplier_name,
      published: row.published === true,
      baseItemLinked: Boolean(row.base_item_id),
      blockers: reasons,
      readyForReview: reasons.length === 0,
    };
  });

  const blockerCounts: Record<string, number> = {};
  for (const row of audited) {
    for (const reason of row.blockers) blockerCounts[reason] = (blockerCounts[reason] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    examined: audited.length,
    published: audited.filter((row) => row.published).length,
    readyForReview: audited.filter((row) => row.readyForReview).length,
    blocked: audited.filter((row) => !row.readyForReview).length,
    blockerCounts,
    items: audited,
    note: "Readiness is an internal preflight only. It does not prove external marketplace publication or live supplier ordering.",
  });
}
