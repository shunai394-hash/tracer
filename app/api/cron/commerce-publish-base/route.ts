import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const searchParams = new URL(request.url).searchParams;
    const requested = Number(searchParams.get("limit") || 20);
    const onlyUnpublished = searchParams.get("onlyUnpublished") !== "false";
    const rawVariantIds = searchParams.get("variantIds");
    let variantIds: string[] | undefined;
    if (rawVariantIds !== null) {
      const supplied = rawVariantIds.split(",").map((value) => value.trim()).filter(Boolean);
      const unique = [...new Set(supplied)];
      if (unique.length === 0 || unique.length > 20 ||
          unique.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
        return NextResponse.json({ ok: false, error: "invalid_variant_ids", maxVariantIds: 20 }, { status: 400 });
      }
      variantIds = unique;
    }
    // Scheduled publication handles new/pending/error rows only. Explicit variantIds
    // enables a bounded, authenticated recovery for a known set of eligible products.
    const limit = Number.isFinite(requested) ? Math.min(20, Math.max(1, Math.floor(requested))) : 20;
    const result = await syncCommerceListings("base", limit, onlyUnpublished, variantIds);
    console.info("[TRACER COMMERCE PUBLISH]", JSON.stringify({ channel: "base", ok: result.failed === 0 && result.staleListings.failed === 0, staleListings: result.staleListings, considered: result.considered, published: result.published, processed: result.processed, failed: result.failed, errors: result.results.filter((item) => !item.ok).slice(0, 10).map((item) => ({ variantId: item.variantId, error: item.error })), staleListingErrors: result.staleListings.errors.slice(0, 10), generatedAt: new Date().toISOString() }));
    const failed = result.failed > 0 || result.staleListings.failed > 0;
    return NextResponse.json({ ok: !failed, ...result }, { status: failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "base", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
