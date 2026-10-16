import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  if (channel !== "base" && channel !== "shopify") {
    return NextResponse.json({ ok: false, error: "channel_must_be_base_or_shopify" }, { status: 400 });
  }
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 3)));
  try {
    const result = await syncCommerceListings(channel, limit);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
