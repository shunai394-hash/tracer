import { NextResponse } from "next/server";

import {
  createECPulseMonitor,
  fetchECPulseProduct,
} from "@/lib/sources/ec-pulse";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      url?: unknown;
      interval_minutes?: unknown;
      webhook_url?: unknown;
    };

    if (typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json({ ok: false, error: "url is required" }, { status: 400 });
    }

    if (
      typeof body.interval_minutes !== "number" ||
      !Number.isInteger(body.interval_minutes) ||
      body.interval_minutes < 1
    ) {
      return NextResponse.json(
        { ok: false, error: "interval_minutes must be a positive integer" },
        { status: 400 },
      );
    }

    if (typeof body.webhook_url !== "string" || !body.webhook_url.trim()) {
      return NextResponse.json(
        { ok: false, error: "webhook_url is required" },
        { status: 400 },
      );
    }

    const product = await fetchECPulseProduct(body.url);
    const monitor = await createECPulseMonitor({
      url: body.url,
      interval_minutes: body.interval_minutes,
      webhook_url: body.webhook_url,
    });

    return NextResponse.json({
      ok: true,
      product,
      monitor,
    });
  } catch (error) {
    console.error("[TRACER EC-PULSE MONITOR ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
