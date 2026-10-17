import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { reverifyCjSupplyIdentities } from "@/lib/suppliers/reverify-cj-identity";
import { isWithinCjQuotaResetReservation } from "@/lib/suppliers/cj-identity-reverify-policy";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Identity re-verification is deliberately isolated from the full intelligence
 * pipeline. CJ enforces a strict 1-request/second quota, and a single listing
 * can require more than one supplier API call. Keep this request comfortably
 * below the GitHub patrol's curl timeout so the next stage never overlaps it.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(25, Math.floor(requestedLimit))) : 25;
    const force = url.searchParams.get("force") === "1";
    const supplierListingIds = [...new Set((url.searchParams.get("supplierListingIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))]
      .slice(0, 10);
    // Do not let the final pre-reset poll exhaust CJ quota immediately before the
    // one-time sandbox lifecycle proof at 00:01 UTC. This is a scheduling guard,
    // not a supplier-evidence bypass; the next normal poll resumes at 00:12 UTC.
    if (isWithinCjQuotaResetReservation(new Date())) {
      console.info("[cj-identity-reverify] skipped daily quota-reset reservation");
      return NextResponse.json({
        ok: true,
        phase: "cj_identity_reverify",
        skipped: true,
        reason: "cj_daily_quota_reset_reservation",
        elapsedMs: Date.now() - startedAt,
        checked: 0,
        promoted: 0,
        supplierVerified: 0,
        noUniqueBarcodeMatch: 0,
        missingEconomics: 0,
        errors: [],
        remediationQueued: [],
        promotedListings: [],
        nextCursor: null,
        quotaBlockedUntil: null,
      });
    }
    const result = await reverifyCjSupplyIdentities({
      // Production telemetry showed 40 checks consuming ~182s and hitting a
      // CJ QPS 429. A 25-row cap leaves room for retries under the 150s budget.
      limit,
      force,
      supplierListingIds,
      deadlineAt: startedAt + 150_000,
    });

    console.info("[cj-identity-reverify] completed", {
      elapsedMs: Date.now() - startedAt,
      checked: result.checked,
      promoted: result.promoted,
      supplierVerified: result.supplierVerified,
      noUniqueBarcodeMatch: result.noUniqueBarcodeMatch,
      missingEconomics: result.missingEconomics,
      errors: result.errors.length,
      quotaBlockedUntil: result.quotaBlockedUntil,
      progress: result.progress,
      targetedListingCount: supplierListingIds.length,
    });

    return NextResponse.json({
      ok: result.errors.length === 0 && result.quotaBlockedUntil === null,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      ...result,
      targetedListingCount: supplierListingIds.length,
      next: "sales_test_publication",
    }, { status: result.errors.length === 0 && result.quotaBlockedUntil === null ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
