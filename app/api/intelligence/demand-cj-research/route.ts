import { NextResponse } from "next/server";
import { researchDemandCandidateWithCJ } from "@/lib/intelligence/research-demand-cj";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      candidateId?: string;
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

    const result = await researchDemandCandidateWithCJ(body.candidateId);

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER DEMAND CJ RESEARCH ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
