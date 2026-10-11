import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { reverifyCjSupplyIdentities } from "@/lib/suppliers/reverify-cj-identity";

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
    const result = await reverifyCjSupplyIdentities({
      // Production telemetry showed 40 checks consuming ~182s and hitting a
      // CJ QPS 429. A 25-row cap leaves room for retries under the 150s budget.
      limit: 25,
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
      progress: result.progress,
    });

    return NextResponse.json({
      ok: result.errors.length === 0,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      ...result,
      next: "sales_test_publication",
    }, { status: result.errors.length === 0 ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
