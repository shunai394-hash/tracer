import { NextResponse } from "next/server";

import {
  createECPulseMonitor,
  fetchECPulseProduct,
  type ECPulseMonitorResponse,
} from "@/lib/sources/ec-pulse";
import {
  persistECPulseMonitorMapping,
  persistECPulseProduct,
} from "@/lib/tracer/persist-ec-pulse";

export const runtime = "nodejs";

function extractMonitorId(response: ECPulseMonitorResponse): string | null {
  if (typeof response.monitor_id === "string" && response.monitor_id.trim()) {
    return response.monitor_id.trim();
  }
  if (typeof response.id === "string" && response.id.trim()) {
    return response.id.trim();
  }
  if (response.monitor && typeof response.monitor === "object") {
    if (typeof response.monitor.monitor_id === "string" && response.monitor.monitor_id.trim()) {
      return response.monitor.monitor_id.trim();
    }
    if (typeof response.monitor.id === "string" && response.monitor.id.trim()) {
      return response.monitor.id.trim();
    }
  }
  return null;
}

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
    const persistedProduct = await persistECPulseProduct(product);
    const monitor = await createECPulseMonitor({
      url: body.url,
      interval_minutes: body.interval_minutes,
      webhook_url: body.webhook_url,
    });

    const monitorId = extractMonitorId(monitor);
    if (!monitorId) {
      return NextResponse.json(
        {
          ok: false,
          error: "EC-Pulse monitor was created but no monitor_id was returned",
          product,
          persistedProduct,
          monitor,
        },
        { status: 502 },
      );
    }

    await persistECPulseMonitorMapping({
      monitorId,
      productId: persistedProduct.productId,
      sourceUrl: product.source.url,
      intervalMinutes: body.interval_minutes,
      webhookUrl: body.webhook_url,
    });

    return NextResponse.json({
      ok: true,
      product,
      persisted: persistedProduct,
      monitor,
      monitorId,
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
