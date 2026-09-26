import { NextResponse } from "next/server";

import {
  persistECPulsePriceChange,
  type ECPulsePriceChangedEvent,
} from "@/lib/tracer/persist-ec-pulse";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";

export const runtime = "nodejs";

function isPriceChangedEvent(
  value: unknown,
): value is ECPulsePriceChangedEvent {
  if (!value || typeof value !== "object") return false;

  const event = value as Record<string, unknown>;

  return (
    event.event === "price_changed" &&
    typeof event.monitor_id === "string" &&
    typeof event.old_price === "number" &&
    Number.isFinite(event.old_price) &&
    typeof event.new_price === "number" &&
    Number.isFinite(event.new_price) &&
    typeof event.url === "string" &&
    typeof event.captured_at === "string"
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;

    if (!isPriceChangedEvent(body)) {
      return NextResponse.json(
        { ok: false, error: "Unsupported EC-Pulse webhook payload" },
        { status: 400 },
      );
    }

    const result = await persistECPulsePriceChange(body);
    const intelligence = await buildOpportunityIntelligence();

    return NextResponse.json({
      ok: true,
      event: body.event,
      result,
      intelligence,
    });
  } catch (error) {
    console.error("[TRACER EC-PULSE WEBHOOK ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
