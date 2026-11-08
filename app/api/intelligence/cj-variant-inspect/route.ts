import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  CJConfigError,
  CJRequestError,
  fetchCJProductVariants,
} from "@/lib/sources/cj/client";

export const runtime = "nodejs";

// Keep this diagnostic endpoint scoped to the three reviewed color families.
// The workflow also checks exact VIDs, but the server must enforce the PID
// boundary independently rather than trusting its caller's query string.
const ALLOWED_AUDIT_PRODUCT_IDS = new Set([
  "2608270931501632200",
  "2611030217281638700",
  "2610130254321621100",
]);

export async function GET(request: Request) {
  // CJ variant data must never be exposed as a public unauthenticated endpoint.
  // Reuse the repository's GitHub OIDC / CRON_SECRET automation gate.
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const pid = searchParams.get("pid")?.trim();

  if (!pid) {
    return NextResponse.json(
      {
        ok: false,
        error: "pid is required",
      },
      { status: 400 },
    );
  }

  if (!ALLOWED_AUDIT_PRODUCT_IDS.has(pid)) {
    return NextResponse.json(
      {
        ok: false,
        error: "pid is not in the approved exact-15 color audit scope",
      },
      { status: 403 },
    );
  }

  try {
    const variants = await fetchCJProductVariants(pid);
    const mismatchedVariants = variants.filter((variant) => variant.productId !== pid);
    if (mismatchedVariants.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "CJ returned variants outside the requested product ID",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      pid,
      count: variants.length,
      variants,
    });
  } catch (error) {
    if (error instanceof CJConfigError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 503 },
      );
    }

    if (error instanceof CJRequestError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 502 },
      );
    }

    console.error("[cj-variant-inspect] unexpected error", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Unexpected CJ variant inspection failure",
      },
      { status: 500 },
    );
  }
}
