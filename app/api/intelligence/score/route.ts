import { NextResponse } from "next/server";
import { scoreProductIntelligence } from "@/lib/intelligence/score-products";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await scoreProductIntelligence();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER SCORE ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
