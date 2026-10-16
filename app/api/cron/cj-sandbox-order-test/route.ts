import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { runCJSandboxOrderLifecycle } from "@/lib/procurement/cj-adapter";
import { isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";

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

  // Never spend a CJ API request while the persisted provider quota circuit is open.
  const { data: quotaRun, error: quotaError } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", "cj-api-quota-circuit")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (quotaError) return NextResponse.json({ ok: false, error: "CJ_QUOTA_CIRCUIT_LOOKUP_FAILED" }, { status: 500 });
  const quotaMetadata = quotaRun?.metadata && typeof quotaRun.metadata === "object" && !Array.isArray(quotaRun.metadata)
    ? quotaRun.metadata as Record<string, unknown>
    : {};
  const blockedUntil = typeof quotaMetadata.blockedUntil === "string" ? quotaMetadata.blockedUntil : null;
  if (isCJQuotaCircuitActive(quotaMetadata)) {
    return NextResponse.json({ ok: false, error: "CJ_API_QUOTA_COOLDOWN", retryAfter: blockedUntil }, { status: 409 });
  }

  // This test exists to establish the order-path contract, so it must accept an
  // unverified candidate. runCJSandboxOrderLifecycle performs fresh exact-variant,
  // price, stock and Japan-freight checks before creating a sandbox-only order.
  const { data: listing, error } = await db
    .from("supplier_listings")
    .select("id,supplier,supplier_product_id,supplier_variant_id,configured,metadata")
    .eq("id", supplierListingId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: "SUPPLIER_LISTING_LOOKUP_FAILED" }, { status: 500 });
  }
  if (
    !listing ||
    listing.supplier !== "cj" ||
    !String(listing.supplier_product_id ?? "").trim() ||
    !String(listing.supplier_variant_id ?? "").trim() ||
    listing.configured !== true
  ) {
    return NextResponse.json({ ok: false, error: "SUPPLIER_LISTING_NOT_CJ_SANDBOX_CANDIDATE" }, { status: 409 });
  }

  // One successful lifecycle is sufficient for this one-time contract proof.
  // Failed attempts are auditable and may be retried only after inspecting the cause.
  const { data: previousRuns, error: previousRunsError } = await db
    .from("cron_runs")
    .select("status,started_at,metadata")
    .eq("job_name", "cj-sandbox-order-lifecycle")
    .order("started_at", { ascending: false })
    .limit(1);
  if (previousRunsError) return NextResponse.json({ ok: false, error: "SANDBOX_AUDIT_LOOKUP_FAILED" }, { status: 500 });
  const previous = previousRuns?.[0];
  if (previous?.status === "succeeded") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_LIFECYCLE_ALREADY_VERIFIED" }, { status: 409 });
  }
  if (previous?.status === "running" && Date.now() - Date.parse(String(previous.started_at)) < 10 * 60 * 1000) {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_LIFECYCLE_ALREADY_RUNNING" }, { status: 409 });
  }

  const startedAt = Date.now();
  const { data: run, error: runError } = await db
    .from("cron_runs")
    .insert({
      job_name: "cj-sandbox-order-lifecycle",
      status: "running",
      metadata: {
        phase: "cj_sandbox_order_lifecycle",
        supplierListingId,
        sandbox: true,
        charged: false,
        realFulfillment: false,
      },
    })
    .select("id")
    .single();
  if (runError || !run?.id) {
    return NextResponse.json({ ok: false, error: "SANDBOX_AUDIT_CLAIM_FAILED" }, { status: 500 });
  }
  const runId = String(run.id);

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
    const sandboxVerifiedAt = new Date().toISOString();
    const existingListingMetadata = listing.metadata && typeof listing.metadata === "object" && !Array.isArray(listing.metadata)
      ? listing.metadata as Record<string, unknown>
      : {};
    const { error: listingEvidenceWriteError } = await db.from("supplier_listings").update({
      metadata: {
        ...existingListingMetadata,
        cj_sandbox_order_path_verified_at: sandboxVerifiedAt,
        cj_sandbox_order_path_evidence: {
          supplierOrderId: result.supplierOrderId,
          supplierProductId: result.verifiedSupplierProductId,
          supplierVariantId: result.verifiedSupplierVariantId,
          unitCostUsd: result.verifiedUnitCostUsd,
          shippingCostUsd: result.verifiedShippingCostUsd,
          inventory: result.verifiedInventory,
          supplierStatus: result.status,
          paymentConfirmed: result.paymentConfirmed,
          trackingNumberPresent: Boolean(result.trackingNumber.trim()),
          sandbox: true,
          charged: false,
          realFulfillment: false,
        },
      },
    }).eq("id", supplierListingId);
    if (listingEvidenceWriteError) throw new Error("CJ_SANDBOX_LISTING_EVIDENCE_WRITE_FAILED");

    const auditMetadata = {
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId,
      supplierOrderId: result.supplierOrderId,
      supplierStatus: result.status,
      paymentConfirmed: result.paymentConfirmed,
      sandbox: result.sandbox,
      charged: result.charged,
      realFulfillment: result.realFulfillment,
      trackingNumberPresent: Boolean(result.trackingNumber.trim()),
    };
    const { error: auditWriteError } = await db.from("cron_runs").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: 1,
      failed: 0,
      metadata: auditMetadata,
    }).eq("id", runId);
    if (auditWriteError) throw new Error("CJ_SANDBOX_AUDIT_WRITE_FAILED");

    console.info("[TRACER CJ SANDBOX ORDER TEST COMPLETE]", JSON.stringify(auditMetadata));
    return NextResponse.json({
      ok: true,
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId,
      ...result,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 240) : "CJ sandbox test failed";
    await db.from("cron_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: 0,
      failed: 1,
      error: detail,
      metadata: {
        phase: "cj_sandbox_order_lifecycle",
        supplierListingId,
        sandbox: true,
        charged: false,
        realFulfillment: false,
      },
    }).eq("id", runId);
    console.error("[TRACER CJ SANDBOX ORDER TEST FAILED]", { supplierListingId, error: detail });
    return NextResponse.json({
      ok: false,
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId,
      error: detail,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
