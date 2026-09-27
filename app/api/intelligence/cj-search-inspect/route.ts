import { NextResponse } from "next/server";
import {
  CJConfigError,
  CJRequestError,
  searchCJProducts,
} from "@/lib/sources/cj/client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return NextResponse.json(
      { ok: false, error: "q is required" },
      { status: 400 },
    );
  }

  try {
    const result = await searchCJProducts(q, {
      page: 1,
      size: 10,
    });

    return NextResponse.json({
      ok: true,
      query: q,
      totalRecords: result.totalRecords,
      totalPages: result.totalPages,
      products: result.products,
    });
  } catch (error) {
    if (error instanceof CJConfigError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 503 },
      );
    }

    if (error instanceof CJRequestError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 502 },
      );
    }

    console.error("[cj-search-inspect] unexpected error", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Unexpected CJ search inspection failure",
      },
      { status: 500 },
    );
  }
}
