import { searchCJProducts, fetchCJVariantStock, calculateCJFreight } from "@/lib/sources/cj";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "Cornucopia Northern Lights Music Star Projector Lamp";
    const vid = url.searchParams.get("vid")?.trim() || "";
    const result = await searchCJProducts(query, { page: 1, size: 5 });
    const variant = vid ? {
      stock: await fetchCJVariantStock(vid),
      freight: await calculateCJFreight(vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
    } : null;
    return Response.json({ ok: true, query, products: result.products, variant });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
