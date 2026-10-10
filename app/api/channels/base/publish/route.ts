import { NextResponse } from "next/server";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { getBasePublicationOutcome } from "@/lib/channels/base-publication-result";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const authError = requireCronAuth(request);
    if (authError) return authError;

    const result = await publishPublishedListingsToBase(20);
    const outcome = getBasePublicationOutcome(result);
    return NextResponse.json(
      { ...outcome, channel: "base", ...result },
      { status: outcome.status },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        channel: "base",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
