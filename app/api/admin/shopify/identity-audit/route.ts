import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Read-only audit of supplier foreign-key links used by publication gates.
 * A row is repairable only when supplier product + variant IDs match exactly
 * one supplier listing that is already identity_status="linked".
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const { data: shopRows, error: shopError } = await db
    .from("shop_listings")
    .select("id,product_id,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id")
    .order("pipeline_updated_at", { ascending: false })
    .limit(1000);
  if (shopError) {
    return NextResponse.json({ ok: false, error: "shop_listings_read_failed" }, { status: 500 });
  }

  const rows = shopRows ?? [];
  const productIds = [...new Set(rows
    .map((row) => String(row.supplier_product_id ?? "").trim())
    .filter(Boolean))];
  const supplierRows: Array<{
    id: string;
    product_id: string | null;
    supplier: string;
    supplier_product_id: string | null;
    supplier_variant_id: string | null;
    identity_status: string | null;
  }> = [];

  for (let offset = 0; offset < productIds.length; offset += 100) {
    const batch = productIds.slice(offset, offset + 100);
    const { data, error } = await db
      .from("supplier_listings")
      .select("id,product_id,supplier,supplier_product_id,supplier_variant_id,identity_status,verification_status,identity_method,identity_confidence,inventory_confirmed,orderable,inventory,cost,currency,shipping_cost,tracking_available,api_available,price_confirmed,last_verified_at,verification_error")
      .eq("supplier", "cj")
      .in("supplier_product_id", batch);
    if (error) {
      return NextResponse.json({ ok: false, error: "supplier_identity_read_failed" }, { status: 500 });
    }
    supplierRows.push(...(data ?? []));
  }

  const byExactPair = new Map<string, typeof supplierRows>();
  for (const supplier of supplierRows) {
    const product = String(supplier.supplier_product_id ?? "").trim();
    const variant = String(supplier.supplier_variant_id ?? "").trim();
    if (!product || !variant) continue;
    const key = JSON.stringify([product, variant]);
    const list = byExactPair.get(key) ?? [];
    list.push(supplier);
    byExactPair.set(key, list);
  }

  const counts = {
    scanned: rows.length,
    supplierListingIdPresent: 0,
    linkedForeignKeyExact: 0,
    foreignKeyStatusNotLinked: 0,
    foreignKeyExactUnlinked: 0,
    foreignKeyExactUnlinkedSameProduct: 0,
    foreignKeyInternalProductMismatch: 0,
    foreignKeyMismatch: 0,
    missingExternalIdentity: 0,
    repairableExactUnique: 0,
    exactMatchUnlinked: 0,
    ambiguousExactMatch: 0,
    noExactMatch: 0,
  };

  const identityStatusCounts: Record<string, number> = {};
  const verificationStatusCounts: Record<string, number> = {};
  const identityMethodCounts: Record<string, number> = {};
  const evidenceCounts = {
    referencedRows: 0,
    inventoryConfirmedTrue: 0,
    orderableTrue: 0,
    trackingAvailableTrue: 0,
    apiAvailableTrue: 0,
    priceConfirmedTrue: 0,
    positiveInventory: 0,
    nonNegativeCostPresent: 0,
    shippingCostPresent: 0,
    lastVerifiedAtPresent: 0,
    verificationErrorPresent: 0,
  };
  // The generated Supabase schema types lag these audit-only evidence columns.
  // Keep the read-only aggregate probe typed as unknown-valued records; each field is narrowed below.
  const supplierById = new Map<string, Record<string, unknown>>(
    supplierRows.map((supplier) => [supplier.id, supplier as unknown as Record<string, unknown>] as const),
  );

  for (const row of rows) {
    const fk = String(row.supplier_listing_id ?? "").trim();
    const product = String(row.supplier_product_id ?? "").trim();
    const variant = String(row.supplier_variant_id ?? "").trim();
    if (fk) counts.supplierListingIdPresent += 1;
    if (!product || !variant) {
      counts.missingExternalIdentity += 1;
      continue;
    }
    const matches = byExactPair.get(JSON.stringify([product, variant])) ?? [];
    const linkedMatches = matches.filter((item) => item.identity_status === "linked");
    if (fk) {
      const referenced = supplierById.get(fk);
      if (!referenced) {
        counts.foreignKeyMismatch += 1;
      } else {
        const status = String(referenced.identity_status ?? "null");
        const verificationStatus = String(referenced.verification_status ?? "null");
        const identityMethod = String(referenced.identity_method ?? "null");
        identityStatusCounts[status] = (identityStatusCounts[status] ?? 0) + 1;
        verificationStatusCounts[verificationStatus] = (verificationStatusCounts[verificationStatus] ?? 0) + 1;
        identityMethodCounts[identityMethod] = (identityMethodCounts[identityMethod] ?? 0) + 1;
        evidenceCounts.referencedRows += 1;
        if (referenced.inventory_confirmed === true) evidenceCounts.inventoryConfirmedTrue += 1;
        if (referenced.orderable === true) evidenceCounts.orderableTrue += 1;
        if (referenced.tracking_available === true) evidenceCounts.trackingAvailableTrue += 1;
        if (referenced.api_available === true) evidenceCounts.apiAvailableTrue += 1;
        if (referenced.price_confirmed === true) evidenceCounts.priceConfirmedTrue += 1;
        if (Number(referenced.inventory) > 0) evidenceCounts.positiveInventory += 1;
        if (referenced.cost !== null && Number.isFinite(Number(referenced.cost)) && Number(referenced.cost) >= 0) evidenceCounts.nonNegativeCostPresent += 1;
        if (referenced.shipping_cost !== null && Number.isFinite(Number(referenced.shipping_cost)) && Number(referenced.shipping_cost) >= 0) evidenceCounts.shippingCostPresent += 1;
        if (referenced.last_verified_at) evidenceCounts.lastVerifiedAtPresent += 1;
        if (referenced.verification_error) evidenceCounts.verificationErrorPresent += 1;
        const exactPair =
          String(referenced.supplier_product_id ?? "").trim() === product &&
          String(referenced.supplier_variant_id ?? "").trim() === variant;
        const sameInternalProduct = String(referenced.product_id ?? "") === String(row.product_id ?? "");
        if (!exactPair) {
          counts.foreignKeyMismatch += 1;
        } else if (!sameInternalProduct) {
          counts.foreignKeyMismatch += 1;
          counts.foreignKeyInternalProductMismatch += 1;
        } else if (status === "linked") {
          counts.linkedForeignKeyExact += 1;
        } else {
          counts.foreignKeyStatusNotLinked += 1;
          counts.foreignKeyExactUnlinked += 1;
          counts.foreignKeyExactUnlinkedSameProduct += 1;
        }
      }
      continue;
    }
    if (linkedMatches.length === 1) counts.repairableExactUnique += 1;
    else if (linkedMatches.length > 1) counts.ambiguousExactMatch += 1;
    else if (matches.length > 0) counts.exactMatchUnlinked += 1;
    else counts.noExactMatch += 1;
  }

  return NextResponse.json({
    ok: true,
    readOnly: true,
    matchingRule: "exact supplier_product_id + supplier_variant_id + supplier=cj + identity_status=linked",
    counts,
    referencedSupplierIdentityStatusCounts: identityStatusCounts,
    referencedSupplierVerificationStatusCounts: verificationStatusCounts,
    referencedSupplierIdentityMethodCounts: identityMethodCounts,
    referencedSupplierEvidenceCounts: evidenceCounts,
    repairPolicy: "No rows were changed. Only repairableExactUnique rows may be considered for a separately audited, idempotent link repair.",
  }, { headers: { "Cache-Control": "no-store" } });
}
