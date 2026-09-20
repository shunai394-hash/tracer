import { NextResponse } from "next/server";
import { generateCJProductQueries } from "@/lib/intelligence/generate-cj-product-queries";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const demandQuery =
      url.searchParams.get("q")?.trim() || "トヨタ・プリウス";

    const queries = await generateCJProductQueries(
      demandQuery,
      "automobile",
    );

    return NextResponse.json({
      ok: true,
      demandQuery,
      queries,
    });
  } catch (error) {
    console.error("[TRACER GEMINI CJ QUERY TEST ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
