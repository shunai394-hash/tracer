import { NextRequest, NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { searchOrosyProducts } from "@/lib/sources/orosy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json(
      { ok: false, error: "q is required" },
      { status: 400 },
    );
  }

  try {
    const products = await searchOrosyProducts(query);

    return NextResponse.json({
      ok: true,
      query,
      count: products.length,
      products,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}


