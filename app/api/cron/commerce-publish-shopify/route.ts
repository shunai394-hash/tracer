import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const requested = Number(new URL(request.url).searchParams.get("limit") || 25);
    const limit = Number.isFinite(requested) ? Math.min(25, Math.max(1, Math.floor(requested))) : 25;
    const onlyUnpublished = new URL(request.url).searchParams.get("onlyUnpublished") !== "false";
    const result = await syncCommerceListings("shopify", limit, onlyUnpublished);
    const failureReasons = result.results.reduce<Record<string, number>>((counts, item) => {
      if (!item.ok) {
        const reason = String(item.error || "unknown").split(":")[0].slice(0, 80);
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    }, {});
    console.info("[commerce-publish] run completed", {
      channel: "shopify", onlyUnpublished, requestedLimit: limit,
      considered: result.considered, published: result.published, failed: result.failed,
      staleChecked: result.staleListings.checked, staleUnpublished: result.staleListings.unpublished,
      staleFailed: result.staleListings.failed, failureReasons,
    });
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "shopify", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
