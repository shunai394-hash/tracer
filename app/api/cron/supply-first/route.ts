import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

// CJ is rate limited to ~1 request/1.1s and each candidate needs four live
// calls (detail, variant, stock, JP freight).
export const maxDuration = 300;

// Supply-first only verifies supplier-side availability.
// It must NOT publish to BASE or deliver to NEWFIND.
// Public sales require the downstream intelligence + sales-test gate.
const DISCOVERY_BUDGET_MS = 180_000;
const DISCOVERY_BATCH_SIZE = 5;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    const supplyFirst = await discoverAndCreateCjSupply(DISCOVERY_BATCH_SIZE, {
      deadlineAt: startedAt + DISCOVERY_BUDGET_MS,
    });

    // Discovery is intentionally not publication. The intelligence pipeline
    // will evaluate these product/offer/intelligence rows before any sales test.
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      supplyFirst,
      publication: {
        published: 0,
        base: false,
        newfind: false,
        reason: "deferred_to_opportunity_intelligence_and_sales_test_gate",
      },
    });
  } catch (error) {
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
