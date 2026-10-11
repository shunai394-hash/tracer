import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { NextResponse } from "next/server";
import { normalizeProductIntelligence } from "@/lib/intelligence/normalize-products";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const result = await normalizeProductIntelligence();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER NORMALIZE ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
