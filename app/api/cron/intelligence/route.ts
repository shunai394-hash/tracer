import { NextResponse } from "next/server";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

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
