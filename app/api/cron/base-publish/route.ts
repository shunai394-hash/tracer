import { NextResponse } from "next/server";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await publishPublishedListingsToBase(20);

    // BASE is the live sales channel; once a listing is actually published
    // there, immediately hand it to NEWFIND for discovery/PR. The promotion
    // function re-checks the Sales Test Gate and is idempotent, so this is
    // safe when the cron sees an already-delivered listing again.
    const baseReadyIds = result.results
      .filter((item) => item.ok && Boolean(item.baseItemId))
      .map((item) => item.listingId);

    const newfind = await Promise.all(
      baseReadyIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          ackStatus: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    return NextResponse.json({
      ok: true,
      phase: "base_publication",
      ...result,
      downstream: {
        baseReady: baseReadyIds.length,
        newfind,
      },
    });
  } catch (error) {
    console.error("[TRACER BASE PUBLICATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "base_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
