import { NextResponse } from "next/server";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await publishPublishedListingsToBase(50);
    return NextResponse.json({
      ok: true,
      phase: "base_publication",
      ...result,
    });
  } catch (error) {
    console.error("[TRACER BASE PUBLICATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "base_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
