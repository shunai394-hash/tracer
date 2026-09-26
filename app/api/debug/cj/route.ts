import { NextRequest, NextResponse } from "next/server";
import {
  getCJProductDetail,
  searchCJProducts,
  fetchCJProductVariants,
} from "@/lib/sources/cj";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();

  if (!query) {
    return NextResponse.json(
      { ok: false, error: "q is required" },
      { status: 400 },
    );
  }

  try {
    const search = await searchCJProducts(query, { page: 1, size: 10 });
    const products = [];

    for (const product of search.products.slice(0, 3)) {
      const detail = await getCJProductDetail(product.id);
      const variants = await fetchCJProductVariants(product.id);
      products.push({
        searchProduct: product,
        detail,
        variants,
      });
    }

    return NextResponse.json({
      ok: true,
      query,
      totalRecords: search.totalRecords,
      totalPages: search.totalPages,
      products,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        query,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
