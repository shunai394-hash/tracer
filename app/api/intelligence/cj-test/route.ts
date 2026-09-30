import { searchCJProducts, fetchCJVariantStock, calculateCJFreight, fetchCJProductVariants } from "@/lib/sources/cj";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "Cornucopia Northern Lights Music Star Projector Lamp";
    const vid = url.searchParams.get("vid")?.trim() || "";
    const result = await searchCJProducts(query, { page: 1, size: 5 });
    const topVariants = result.products[0] ? await fetchCJProductVariants(result.products[0].id, { countryCode: "JP" }) : [];\n    const variant = vid ? {
      stock: await fetchCJVariantStock(vid),
      freight: await calculateCJFreight(vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
    } : null;
    return Response.json({ ok: true, query, products: result.products, topVariants, variant });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
