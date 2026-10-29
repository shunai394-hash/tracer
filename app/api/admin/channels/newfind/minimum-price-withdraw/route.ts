import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { withdrawBelowMinimumPriceCommercePromotions } from "@/lib/integration/newfind-commerce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Explicit one-shot withdrawal of already-delivered NEWFIND canonical promotions
 * below the ¥2,500 public selling-price floor. Requires automation auth and
 * ?execute=1; no withdrawal is attempted by an ordinary request.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  if (url.searchParams.get("execute") !== "1") {
    return NextResponse.json({
      ok: false,
      readOnly: true,
      error: "explicit_execute_flag_required",
      usage: "?execute=1&limit=20",
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const rawLimit = Number(url.searchParams.get("limit") || 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 20;
  try {
    const result = await withdrawBelowMinimumPriceCommercePromotions({ limit });
    if (!result.enabled || !result.configured) {
      return NextResponse.json({
        ok: false,
        readOnly: true,
        error: !result.enabled ? "newfind_receiver_not_enabled" : "newfind_receiver_not_configured",
        result,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({
      ok: result.failed.length === 0,
      readOnly: false,
      mode: "explicit_minimum_price_withdrawal",
      minimumSellingPriceJpy: 2500,
      result,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      readOnly: false,
      error: error instanceof Error ? error.message : "newfind_minimum_price_withdraw_failed",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
