import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Single scheduled entry point for the shared commerce catalog.
 * Product eligibility and canonical pricing stay in syncCommerceListings;
 * this route only fans the same bounded batch out to each sales channel.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") || 5);
  const limit = Number.isFinite(requested)
    ? Math.min(5, Math.max(1, Math.floor(requested)))
    : 5;
  const onlyUnpublished = url.searchParams.get("onlyUnpublished") !== "false";

  const channels = ["base", "shopify"] as const;
  const results: Record<string, unknown> = {};
  let failed = false;

  // Sequential calls avoid multiplying concurrent writes to storefront APIs.
  for (const channel of channels) {
    try {
      const result = await syncCommerceListings(channel, limit, onlyUnpublished);
      results[channel] = result;
      if (result.failed > 0) failed = true;
    } catch (error) {
      failed = true;
      results[channel] = {
        channel,
        failed: 1,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      };
    }
  }

  return NextResponse.json(
    { ok: !failed, mode: "unified-commerce-publish", limit, onlyUnpublished, results },
    { status: failed ? 207 : 200 },
  );
}
