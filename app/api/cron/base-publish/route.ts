import { NextResponse } from "next/server";
import { isBaseConfigured } from "@/lib/channels/base";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { getBasePublicationOutcome } from "@/lib/channels/base-publication-result";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const headers = { "Cache-Control": "no-store" };
  if (!isBaseConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        phase: "base_publication",
        configured: false,
        error: "BASE_API_CREDENTIALS_NOT_CONFIGURED",
      },
      { status: 503, headers },
    );
  }

  try {
    const result = await publishPublishedListingsToBase(50);
    const outcome = getBasePublicationOutcome(result);
    return NextResponse.json({
      ...outcome,
      phase: "base_publication",
      configured: true,
      ...result,
    }, { status: outcome.status, headers });
  } catch (error) {
    console.error("[TRACER BASE PUBLICATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "base_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers },
    );
  }
}
