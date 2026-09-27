import { NextResponse } from "next/server";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

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
