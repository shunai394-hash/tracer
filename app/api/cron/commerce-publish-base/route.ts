import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const requested = Number(new URL(request.url).searchParams.get("limit") || 5);
    // Scheduled publication handles new/pending/error rows only. The reprice cron explicitly
    // passes selected stale variant IDs when an existing published price must be refreshed.
    const limit = Number.isFinite(requested) ? Math.min(5, Math.max(1, Math.floor(requested))) : 5;
    const onlyUnpublished = new URL(request.url).searchParams.get("onlyUnpublished") !== "false";
    const result = await syncCommerceListings("base", limit, onlyUnpublished);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "base", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
