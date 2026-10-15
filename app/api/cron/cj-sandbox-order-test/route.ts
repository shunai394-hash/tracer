import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { runCJSandboxOrderLifecycle } from "@/lib/procurement/cj-adapter";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  // Explicit opt-in only. This route is not registered as a Vercel Cron.
  if (process.env.CJ_SANDBOX_ORDER_TEST_ENABLED !== "1") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_ORDER_TEST_DISABLED" }, { status: 404 });
  }

  let body: { supplierListingId?: unknown };
  try {
    body = await request.json() as { supplierListingId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const supplierListingId = typeof body.supplierListingId === "string" ? body.supplierListingId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplierListingId)) {
    return NextResponse.json({ ok: false, error: "SUPPLIER_LISTING_ID_REQUIRED" }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const { data: listing, error } = await db
    .from("supplier_listings")
    .select("id,supplier,supplier_product_id,supplier_variant_id,verification_status,shipping_status,configured,price_confirmed,inventory_confirmed,api_available,orderable,tracking_available,inventory,last_verified_at")
    .eq("id", supplierListingId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: "SUPPLIER_LISTING_LOOKUP_FAILED" }, { status: 500 });
  }
  const lastVerifiedAt = listing?.last_verified_at ? Date.parse(String(listing.last_verified_at)) : Number.NaN;
  const fresh = Number.isFinite(lastVerifiedAt) && lastVerifiedAt >= Date.now() - 7 * 24 * 60 * 60 * 1000 && lastVerifiedAt <= Date.now() + 5 * 60 * 1000;
  if (
    !listing ||
    listing.supplier !== "cj" ||
    !listing.supplier_product_id ||
    !listing.supplier_variant_id ||
    listing.verification_status !== "verified" ||
    listing.shipping_status !== "verified" ||
    listing.configured !== true ||
    listing.price_confirmed !== true ||
    listing.inventory_confirmed !== true ||
    listing.api_available !== true ||
    listing.orderable !== true ||
    listing.tracking_available !== true ||
    Number(listing.inventory) < 1 ||
    !fresh
  ) {
    return NextResponse.json({ ok: false, error: "SUPPLIER_LISTING_NOT_FRESH_VERIFIED_FOR_SANDBOX" }, { status: 409 });
  }

  try {
    const result = await runCJSandboxOrderLifecycle({
      supplierProductId: String(listing.supplier_product_id),
      supplierVariantId: String(listing.supplier_variant_id),
      orderNumber: `TRACER-SANDBOX-${Date.now()}`,
      quantity: 1,
      shippingCountryCode: "JP",
      shippingCountry: "Japan",
      shippingProvince: "Tokyo",
      shippingCity: "Chiyoda-ku",
      shippingAddress: "1-1 Chiyoda",
      shippingZip: "1000001",
      shippingPhone: "00000000000",
      shippingCustomerName: "TRACER SANDBOX TEST",
      email: "sandbox-test@example.invalid",
    });
    return NextResponse.json({
      ok: true,
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId,
      ...result,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[TRACER CJ SANDBOX ORDER TEST FAILED]", {
      supplierListingId,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    return NextResponse.json({
      ok: false,
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId,
      error: error instanceof Error ? error.message.slice(0, 240) : "CJ sandbox test failed",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
