import { NextResponse } from "next/server";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authError = requireCronAuth(request);
    if (authError) return authError;

    const result = await publishPublishedListingsToBase(20);
    return NextResponse.json({ ok: true, channel: "base", ...result });
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
