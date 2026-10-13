import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { observeCjNativeIdentity, recordCjNativeIdentity, type CjNativeIdentityCandidate } from "@/lib/suppliers/verify-cj-native-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Proves CJ-native identity (cj_native_variant) for CJ supplier listings by
 * reading CJ live: exact product+variant ids, uniqueness, stock, price, Japan
 * freight, product image and variant spec. Each listing costs about five CJ
 * API calls, so one run checks at most 10 listings.
 *
 * POST body: { "apply": false, "limit": 10, "listingIds": ["..."] }
 * Without apply:true this is a dry run: CJ is read, the database is not written.
 * Nothing here publishes a product or places an order.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { apply?: unknown; limit?: unknown; listingIds?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const requestedLimit = Number(body.limit ?? 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.floor(requestedLimit))) : 10;
  const listingIds = Array.isArray(body.listingIds)
    ? body.listingIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 10)
    : [];

  const db = createSupabaseAdminClient();
  let query = db
    .from("supplier_listings")
    .select("id,product_id,supplier_product_id,supplier_variant_id,title,identity_method,identity_status,metadata")
    .eq("supplier", "cj")
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null);
  query = listingIds.length > 0
    ? query.in("id", listingIds)
    : query
      .in("identity_method", ["supply_discovered", "none", "cj_native_variant"])
      .eq("verification_status", "verified")
      .eq("shipping_status", "verified")
      .order("last_verified_at", { ascending: true, nullsFirst: true });
  const { data, error } = await query.limit(limit);
  if (error) return NextResponse.json({ ok: false, error: "supplier_listings_read_failed" }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];
  const reasonCounts: Record<string, number> = {};
  let verified = 0;
  let writeFailures = 0;
  for (const raw of data ?? []) {
    const row = raw as CjNativeIdentityCandidate;
    const decision = await observeCjNativeIdentity(db, row);
    if (decision.verified) verified += 1;
    for (const reason of decision.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    let write: Awaited<ReturnType<typeof recordCjNativeIdentity>> | null = null;
    if (apply) {
      write = await recordCjNativeIdentity(db, row, decision);
      if (!write.ok) writeFailures += 1;
    }
    results.push({
      supplierListingId: row.id,
      productId: row.product_id,
      verified: decision.verified,
      reasons: decision.reasons,
      evidence: decision.evidence,
      ...(write ? { write: write.changed, writeError: write.error } : {}),
    });
  }

  return NextResponse.json({
    ok: writeFailures === 0,
    apply,
    dryRun: !apply,
    checked: results.length,
    verified,
    rejected: results.length - verified,
    writeFailures,
    reasonCounts,
    results,
    note: "cj_native_variant proves the CJ product and variant exist and match; it does not publish, and CJ live ordering stays disabled.",
  }, { status: writeFailures === 0 ? 200 : 500 });
}
