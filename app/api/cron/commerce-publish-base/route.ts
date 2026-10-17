import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    // Channel APIs require several sequential remote calls per listing. Keep each
    // cron invocation small so a slow BASE response cannot time out the whole batch.
    // Pending and failed rows are retried; already-published rows are not rewritten
    // every 15 minutes. The cron prioritizes unpublished variants by default.
    const requested = Number(new URL(request.url).searchParams.get("limit") || 5);
    const limit = Number.isFinite(requested) ? Math.min(5, Math.max(1, Math.floor(requested))) : 5;
    const onlyUnpublished = new URL(request.url).searchParams.get("onlyUnpublished") !== "false";
    const result = await syncCommerceListings("base", limit, onlyUnpublished);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "base", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
