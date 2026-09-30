import { NextRequest, NextResponse } from "next/server";
import { searchCJProducts } from "@/lib/sources/cj";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

/**
 * Internal CJ connectivity check.
 * This endpoint spends the server-side CJ API credential and must remain
 * protected by the operational cron secret.
 */
export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "wireless earbuds";
    const result = await searchCJProducts(query, { page: 1, size: 5 });
    return NextResponse.json({
      ok: true,
      query,
      totalRecords: result.totalRecords,
      totalPages: result.totalPages,
      productCount: result.products.length,
      products: result.products,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
