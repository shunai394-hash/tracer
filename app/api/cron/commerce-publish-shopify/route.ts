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
    const requested = Number(searchParams.get("limit") || 5);
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
    const limit = Number.isFinite(requested) ? Math.min(10, Math.max(1, Math.floor(requested))) : 5;
    const result = await syncCommerceListings("shopify", limit, onlyUnpublished, variantIds);
    console.info("[TRACER COMMERCE PUBLISH]", JSON.stringify({ channel: "shopify", ok: result.failed === 0, considered: result.considered, published: result.published, processed: result.processed, failed: result.failed, errors: result.results.filter((item) => !item.ok).slice(0, 10).map((item) => ({ variantId: item.variantId, error: item.error })), generatedAt: new Date().toISOString() }));
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "shopify", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
