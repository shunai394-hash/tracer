import { NextResponse } from "next/server";
import {
  getSuperDeliveryCatalog,
  SuperDeliveryConfigError,
  SuperDeliveryRequestError,
} from "@/lib/sources/superdelivery/client";
import { getSuperDeliveryConfig } from "@/lib/config/env";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Read-only SUPER DELIVERY connectivity diagnostic.
 *
 * This endpoint never writes to TRACER/Supabase. It only verifies that the
 * SUPER DELIVERY ProductSetSearch API can be reached with the configured
 * apiAuthCode and reports the normalized catalogue size.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const config = getSuperDeliveryConfig();

  if (!config.apiAuthCode) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        code: "SUPERDELIVERY_NOT_CONFIGURED",
        message: "SUPERDELIVERY_API_AUTH_CODE is not configured.",
      },
      { status: 503 },
    );
  }

  const startedAt = Date.now();

  try {
    const catalog = await getSuperDeliveryCatalog();

    return NextResponse.json({
      ok: true,
      configured: true,
      elapsedMs: Date.now() - startedAt,
      catalogItems: catalog.length,
      stockedItems: catalog.filter(
        (item) => item.stock !== null && item.stock > 0,
      ).length,
      listedItems: catalog.filter((item) => item.exhibitState === 2).length,
      fieldsObserved: {
        jan: catalog.filter((item) => item.janCode !== null).length,
        stock: catalog.filter((item) => item.stock !== null).length,
        price: catalog.filter((item) => item.price !== null).length,
        image: catalog.filter((item) => item.imageUrl !== null).length,
      },
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    if (
      error instanceof SuperDeliveryConfigError ||
      error instanceof SuperDeliveryRequestError
    ) {
      return NextResponse.json(
        {
          ok: false,
          configured: true,
          code: error.code,
          message: error.message,
          elapsedMs: Date.now() - startedAt,
        },
        { status: 502 },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        code: "SUPERDELIVERY_DIAGNOSTIC_FAILED",
        message,
        elapsedMs: Date.now() - startedAt,
      },
      { status: 502 },
    );
  }
}
