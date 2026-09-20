import { NextResponse } from "next/server";
import { persistDemandCJProducts } from "@/lib/intelligence/persist-demand-cj-products";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      candidateId?: string;
      limit?: number;
    };

    if (!body.candidateId) {
      return NextResponse.json(
        {
          ok: false,
          error: "candidateId is required",
        },
        { status: 400 },
      );
    }

    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.min(Math.max(Math.floor(body.limit), 1), 100)
        : 1;

    const result = await persistDemandCJProducts(
      body.candidateId,
      limit,
    );

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER DEMAND CJ PERSIST ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
