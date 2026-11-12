import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { listSellableAiLiveProducts } from "@/lib/ai-live/sellable-products";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Read-only, minimized product feed for the AI live program.
 * This route intentionally exposes no supplier IDs, source costs, shipping
 * costs, margin/profit, credentials, order data, or internal gate diagnostics.
 * It never mutates listings or calls an external commerce API.
 */
function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function GET(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
    : 10;

  try {
    const db = createSupabaseAdminClient();
    const products = await listSellableAiLiveProducts(db, limit);
    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        count: products.length,
        products,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "ai_live_product_read_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
