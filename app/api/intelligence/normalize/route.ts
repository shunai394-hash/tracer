import { NextResponse } from "next/server";
import { normalizeProductIntelligence } from "@/lib/intelligence/normalize-products";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await normalizeProductIntelligence();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER NORMALIZE ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
