import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Repairs only a missing supplier_listings FK when the external CJ product +
 * variant pair maps to exactly one already-linked row for the same internal
 * product. This never creates identity evidence or publishes products.
 *
 * POST body: { "apply": true, "limit": 1000 }
 * Without apply:true the endpoint is a dry-run.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { apply?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const apply = body.apply === true;
  const requestedLimit = Number(body.limit ?? 1000);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
    : 1000;

  const db = createSupabaseAdminClient();
  const { data: shopRows, error: shopError } = await db
    .from("shop_listings")
    .select("id,product_id,supplier_listing_id,supplier_product_id,supplier_variant_id")
    .is("supplier_listing_id", null)
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .order("pipeline_updated_at", { ascending: false })
    .limit(limit);

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
      .select("id,product_id,supplier,supplier_product_id,supplier_variant_id,identity_status")
      .eq("supplier", "cj")
      .eq("identity_status", "linked")
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
    const matches = byExactPair.get(key) ?? [];
    matches.push(supplier);
    byExactPair.set(key, matches);
  }

  const results: Array<{ shopListingId: string; outcome: string; supplierListingId?: string }> = [];
  let repaired = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let internalProductMismatch = 0;

  for (const row of rows) {
    const shopListingId = String(row.id);
    const externalProduct = String(row.supplier_product_id ?? "").trim();
    const externalVariant = String(row.supplier_variant_id ?? "").trim();
    const matches = byExactPair.get(JSON.stringify([externalProduct, externalVariant])) ?? [];

    if (matches.length === 0) {
      noMatch += 1;
      results.push({ shopListingId, outcome: "no_exact_linked_supplier_match" });
      continue;
    }
    if (matches.length !== 1) {
      ambiguous += 1;
      results.push({ shopListingId, outcome: "ambiguous_exact_supplier_match" });
      continue;
    }

    const supplier = matches[0];
    if (String(supplier.product_id ?? "") !== String(row.product_id ?? "")) {
      internalProductMismatch += 1;
      results.push({ shopListingId, outcome: "internal_product_mismatch" });
      continue;
    }

    if (!apply) {
      results.push({
        shopListingId,
        outcome: "repairable_dry_run",
        supplierListingId: supplier.id,
      });
      continue;
    }

    // Compare-and-set prevents overwriting a link created concurrently.
    const { data: updated, error: updateError } = await db
      .from("shop_listings")
      .update({ supplier_listing_id: supplier.id })
      .eq("id", row.id)
      .is("supplier_listing_id", null)
      .select("id")
      .maybeSingle();

    if (updateError) {
      results.push({ shopListingId, outcome: "update_failed" });
      continue;
    }
    if (!updated) {
      results.push({ shopListingId, outcome: "already_changed_concurrently" });
      continue;
    }
    repaired += 1;
    results.push({
      shopListingId,
      outcome: "foreign_key_repaired",
      supplierListingId: supplier.id,
    });
  }

  console.info("[cj-identity-link-repair] completed", {
    apply,
    scanned: rows.length,
    repaired,
    ambiguous,
    noMatch,
    internalProductMismatch,
  });

  return NextResponse.json({
    ok: true,
    apply,
    readOnly: !apply,
    matchingRule: "exact CJ product+variant, exactly one identity_status=linked row, and matching internal product_id",
    scanned: rows.length,
    repairable: results.filter((row) => row.outcome === "repairable_dry_run").length,
    repaired,
    ambiguous,
    noMatch,
    internalProductMismatch,
    results,
    publicationChanged: false,
  }, { headers: { "Cache-Control": "no-store" } });
}
