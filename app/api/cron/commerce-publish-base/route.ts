import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const result = await syncCommerceListings("base", 3);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "base", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
