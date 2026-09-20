import { searchCJProducts } from "@/lib/sources/cj";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "wireless earbuds";

    const result = await searchCJProducts(query, {
      page: 1,
      size: 5,
    });

    return Response.json({
      ok: true,
      query: result.query,
      totalRecords: result.totalRecords,
      totalPages: result.totalPages,
      productCount: result.products.length,
      products: result.products,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
