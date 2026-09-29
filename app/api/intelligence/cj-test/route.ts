import { searchCJProducts } from "@/lib/sources/cj";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

/**
 * Internal CJ connectivity check.
 *
 * This endpoint spends the server-side CJ API credential and therefore must
 * never be publicly callable. Use the same CRON_SECRET gate as the other
 * operational/debug endpoints.
 */
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

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
