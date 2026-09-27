import { NextResponse } from "next/server";
import { collectNewProducts } from "@/lib/sources/new-products";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await collectNewProducts();

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    const stack =
      error instanceof Error ? error.stack ?? null : null;

    console.error("[products/collect] FAILED", {
      message,
      stack,
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        error: message,
        stack,
      },
      { status: 500 },
    );
  }
}
