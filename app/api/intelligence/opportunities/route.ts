import { NextResponse } from "next/server";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { listOpportunities } from "@/lib/intelligence/opportunity-store";
import type { SellabilityState } from "@/lib/domain/types";

export const runtime = "nodejs";

const STATES: SellabilityState[] = [
  "NEEDS_DATA",
  "WATCH",
  "SELLABLE",
  "TEST_READY",
  "REJECTED",
];

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const stateParam = url.searchParams.get("state");
    const state = STATES.includes(stateParam as SellabilityState)
      ? (stateParam as SellabilityState)
      : undefined;

    const opportunities = await listOpportunities({
      state,
      includeRejected: url.searchParams.get("includeRejected") === "1",
    });

    return NextResponse.json({
      ok: true,
      count: opportunities.length,
      opportunities,
    });
  } catch (error) {
    console.error("[TRACER OPPORTUNITIES ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const result = await buildOpportunityIntelligence();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER OPPORTUNITY BUILD ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
