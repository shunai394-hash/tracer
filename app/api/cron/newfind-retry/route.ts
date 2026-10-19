import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { promoteCommerceListingsToNewfind } from "@/lib/integration/newfind-commerce";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Legacy broad retry is intentionally disabled. A retry is permitted only when
 * the caller supplies one exact commerce variant ID; the delivery helper still
 * enforces canonical listing, fresh verified CJ evidence, positive profit,
 * backoff/attempt limits, and receiver ACK handling.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId")?.trim();
  const supplierVariantId = url.searchParams.get("supplierVariantId")?.trim();
  if (!variantId) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "explicit_variant_id_required",
    });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(variantId)) {
    return NextResponse.json({ ok: false, error: "invalid_variant_id" }, { status: 400 });
  }
  if (!supplierVariantId || !/^[0-9]{10,25}$/.test(supplierVariantId)) {
    return NextResponse.json({ ok: false, error: "exact_supplier_variant_id_required" }, { status: 400 });
  }

  try {
    const result = await promoteCommerceListingsToNewfind({
      limit: 1,
      variantIds: [variantId],
      expectedSupplierVariantId: supplierVariantId,
    });
    if (!result.receiverReady || !result.configured) {
      return NextResponse.json({ ok: false, error: "newfind_receiver_not_ready", variantId, result }, { status: 503 });
    }
    if (result.candidates !== 1) {
      return NextResponse.json({ ok: false, error: "canonical_candidate_not_unique", variantId, result }, { status: 409 });
    }
    if (result.supplierVariantMatch !== true) {
      return NextResponse.json({ ok: false, error: "supplier_variant_mapping_mismatch", variantId, result }, { status: 409 });
    }
    if (result.failed.length > 0) {
      return NextResponse.json({ ok: false, error: "newfind_delivery_failed", variantId, result }, { status: 502 });
    }
    if (result.processed !== 1 && result.alreadyProcessed !== 1) {
      return NextResponse.json({ ok: false, error: "newfind_delivery_not_confirmed", variantId, result }, { status: 409 });
    }
    return NextResponse.json({ ok: true, variantId, result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      variantId,
      error: error instanceof Error ? error.message : "newfind_retry_failed",
    }, { status: 500 });
  }
}
