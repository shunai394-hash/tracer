import { NextResponse } from "next/server";
import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await collectGoogleTrendsDemand();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER DEMAND ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
