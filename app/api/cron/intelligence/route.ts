import { NextResponse } from "next/server";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const authError = requireCronAuth(request);
    if (authError) return authError;

    const result = await runIntelligencePipeline();

    return NextResponse.json({
      ok: true,
      complete: result.complete,
      isolated: result.ok,
      steps: result.steps,
    });
  } catch (error) {
    console.error("[TRACER INTELLIGENCE CRON ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
