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
  // Keep the sandbox route aligned with the shared CJ quota policy. Legacy
  // provider_points_remaining_zero rows came from the old QPS/points conflation
  // and must not block a bounded sandbox proof; explicit daily-point exhaustion
  // still returns 409 before any provider call.
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
    .select("status,started_at,metadata,error")
    .eq("job_name", "cj-sandbox-order-lifecycle")
    .order("started_at", { ascending: false })
    .limit(1);
  if (previousRunsError) return NextResponse.json({ ok: false, error: "SANDBOX_AUDIT_LOOKUP_FAILED" }, { status: 500 });
  const previous = previousRuns?.[0];
  if (previous?.status === "succeeded") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_LIFECYCLE_ALREADY_VERIFIED" }, { status: 409 });
  }
  const previousError = typeof previous?.error === "string" ? previous.error : "";
  const previousMetadata = previous?.metadata && typeof previous.metadata === "object" && !Array.isArray(previous.metadata)
    ? previous.metadata as Record<string, unknown>
    : {};
  // A prior sandbox-only order can be retried after this exact pre-payment
  // transition failure: the old order remained CREATED, no payment was made,
  // and no real fulfillment occurred. This exception must never apply to live orders.
  const previousFailureWasSafeSandboxTransition =
    previousError === "Current order status is CREATED(100), not UNPAID(200), cannot simulate pay." &&
    previousMetadata.sandbox === true &&
    previousMetadata.charged === false &&
    previousMetadata.realFulfillment === false;
  const previousFailureWasPreOrderOnly =
    previousError.startsWith("CJ_SANDBOX_NO_VALID_CANDIDATE:") ||
    previousError.startsWith("CJ_SANDBOX_VARIANT_NOT_FOUND:") ||
    previousError.startsWith("CJ_SANDBOX_PRODUCT_ID_MISMATCH:") ||
    previousError === "CJ_SANDBOX_STOCK_OR_PRICE_UNVERIFIED" ||
    previousError === "CJ_SANDBOX_SHIPPING_UNAVAILABLE" ||
    previousError === "CJ_SANDBOX_COUNTRY_UNVERIFIED" ||
    previousFailureWasSafeSandboxTransition;
  if (previous?.status === "failed" && !previousFailureWasPreOrderOnly) {
    return NextResponse.json({
      ok: false,
      error: "CJ_SANDBOX_PREVIOUS_ORDER_MAY_EXIST_REQUIRES_MANUAL_RECONCILIATION",
    }, { status: 409 });
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
  let activeListing = listing;
  const attemptedListingIds: string[] = [];

  try {
    const { data: candidateRows, error: candidateError } = await db
      .from("supplier_listings")
      .select("id,supplier,supplier_product_id,supplier_variant_id,configured,cost,shipping_cost,currency,inventory,ship_to,shipping_status,price_confirmed,inventory_confirmed,metadata")
      .eq("supplier", "cj")
      .eq("configured", true)
      .eq("price_confirmed", true)
      .eq("inventory_confirmed", true)
      .eq("shipping_status", "verified")
      .eq("ship_to", "JP")
      .gt("inventory", 0)
      .order("id", { ascending: true })
      .limit(12);
    if (candidateError) throw new Error("CJ_SANDBOX_CANDIDATE_SCAN_FAILED");

    const validCandidate = (candidate: typeof listing) =>
      candidate.supplier === "cj" &&
      candidate.configured === true &&
      /^\d{10,25}$/.test(String(candidate.supplier_product_id ?? "")) &&
      /^\d{10,25}$/.test(String(candidate.supplier_variant_id ?? ""));
    const alternatives = (candidateRows ?? []).filter((candidate) =>
      candidate.id !== listing.id &&
      validCandidate(candidate as typeof listing) &&
      !(candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        && "cj_sandbox_order_path_verified_at" in candidate.metadata)
    );
    // Skip the requested row if it contains internal UUIDs instead of CJ-native numeric IDs.
    // Otherwise the first invalid candidate aborts before valid alternatives are attempted.
    const candidates = [listing, ...alternatives.slice(0, 2)].filter((candidate) => validCandidate(candidate as typeof listing));
    let result: Awaited<ReturnType<typeof runCJSandboxOrderLifecycle>> | null = null;
    let lastPreOrderFailure = "";

    for (const candidate of candidates) {
      activeListing = candidate as typeof listing;
      attemptedListingIds.push(String(activeListing.id));
      try {
        result = await runCJSandboxOrderLifecycle({
          supplierProductId: String(activeListing.supplier_product_id),
          supplierVariantId: String(activeListing.supplier_variant_id),
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
        }, async (supplierOrderId) => {
          // Persist the external CJ sandbox order ID before later lifecycle steps.
          // This makes failures reconcilable and prevents blind duplicate retries.
          const { error: externalOrderIdWriteError } = await db.from("cron_runs").update({
            metadata: {
              phase: "cj_sandbox_order_lifecycle",
              supplierListingId: activeListing.id,
              attemptedListingIds,
              supplierOrderId,
              sandbox: true,
              charged: false,
              realFulfillment: false,
            },
          }).eq("id", runId);
          if (externalOrderIdWriteError) throw new Error("CJ_SANDBOX_EXTERNAL_ORDER_ID_AUDIT_FAILED");
        });
        break;
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 240) : "CJ sandbox test failed";
        const safeToTryAnotherCandidate =
          detail.startsWith("CJ_SANDBOX_VARIANT_NOT_FOUND:") ||
          detail.startsWith("CJ_SANDBOX_PRODUCT_ID_MISMATCH:") ||
          detail === "CJ_SANDBOX_STOCK_OR_PRICE_UNVERIFIED" ||
          detail === "CJ_SANDBOX_SHIPPING_UNAVAILABLE" ||
          detail === "CJ_SANDBOX_COUNTRY_UNVERIFIED";
        if (!safeToTryAnotherCandidate) throw error;
        lastPreOrderFailure = detail;
        console.warn("[TRACER CJ SANDBOX CANDIDATE REJECTED BEFORE ORDER CREATION]", {
          supplierListingId: activeListing.id,
          error: detail,
        });
      }
    }
    if (!result) throw new Error(`CJ_SANDBOX_NO_VALID_CANDIDATE:${lastPreOrderFailure || "no_candidates"}`);

    const sandboxVerifiedAt = new Date().toISOString();
    const existingListingMetadata = activeListing.metadata && typeof activeListing.metadata === "object" && !Array.isArray(activeListing.metadata)
      ? activeListing.metadata as Record<string, unknown>
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
    }).eq("id", activeListing.id);
    if (listingEvidenceWriteError) throw new Error("CJ_SANDBOX_LISTING_EVIDENCE_WRITE_FAILED");

    const auditMetadata = {
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId: activeListing.id,
      attemptedListingIds,
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
      supplierListingId: activeListing.id,
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
        supplierListingId: activeListing.id,
        attemptedListingIds,
        sandbox: true,
        charged: false,
        realFulfillment: false,
      },
    }).eq("id", runId);
    console.error("[TRACER CJ SANDBOX ORDER TEST FAILED]", { supplierListingId: activeListing.id, error: detail });
    return NextResponse.json({
      ok: false,
      phase: "cj_sandbox_order_lifecycle",
      supplierListingId: activeListing.id,
      error: detail,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
