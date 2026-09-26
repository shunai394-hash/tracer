import { NextResponse } from "next/server";

import { listECPulseMonitors } from "@/lib/sources/ec-pulse";

export const runtime = "nodejs";

export async function GET() {
  try {
    const monitors = await listECPulseMonitors();

    return NextResponse.json({
      ok: true,
      monitors,
    });
  } catch (error) {
    console.error("[TRACER EC-PULSE MONITORS ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
