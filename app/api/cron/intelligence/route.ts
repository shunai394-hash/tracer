import { NextResponse } from "next/server";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;

    // Finish (and report) well before Vercel kills the function at 300s.
    const result = await runIntelligencePipeline({ deadlineAt: Date.now() + 240_000 });

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
