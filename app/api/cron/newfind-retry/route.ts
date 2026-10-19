import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { promoteCommerceListingsToNewfind } from "@/lib/integration/newfind-commerce";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Legacy broad retry is intentionally disabled. A retry is permitted only when
 * the caller supplies one exact commerce variant ID; the delivery helper still
 * enforces canonical listing, fresh verified CJ evidence, positive profit,
 * backoff/attempt limits, and receiver ACK handling.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId")?.trim();
  if (!variantId) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "explicit_variant_id_required",
    });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(variantId)) {
    return NextResponse.json({ ok: false, error: "invalid_variant_id" }, { status: 400 });
  }

  try {
    const result = await promoteCommerceListingsToNewfind({ limit: 1, variantIds: [variantId] });
    return NextResponse.json({ ok: result.failed.length === 0, variantId, result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      variantId,
      error: error instanceof Error ? error.message : "newfind_retry_failed",
    }, { status: 500 });
  }
}
