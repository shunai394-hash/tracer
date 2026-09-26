import { NextResponse } from "next/server";

import { fetchECPulseProduct } from "@/lib/sources/ec-pulse";
import { persistECPulseProduct } from "@/lib/tracer/persist-ec-pulse";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: unknown };

    if (typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 },
      );
    }

    const product = await fetchECPulseProduct(body.url);
    const persisted = await persistECPulseProduct(product);

    return NextResponse.json({
      ok: true,
      product,
      persisted,
    });
  } catch (error) {
    console.error("[TRACER EC-PULSE PRODUCT ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
