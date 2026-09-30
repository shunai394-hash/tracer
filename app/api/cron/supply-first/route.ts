import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
// CJ is rate limited to ~1 request/1.1s and each candidate needs four live
// calls (detail, variant, stock, JP freight), so 60s could not even finish a
// dozen candidates plus BASE/NEWFIND. Match sales-test-publication's budget.
export const maxDuration = 300;

// Leave headroom after supplier verification for BASE creation + NEWFIND.
const DISCOVERY_BUDGET_MS = 180_000;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();
    const supplyFirst = await discoverAndCreateCjSupply(50, {
      deadlineAt: startedAt + DISCOVERY_BUDGET_MS,
    });

    const discoveredListingIds = supplyFirst.items
      .map((item) => String(item.listingId ?? ""))
      .filter(Boolean);

    // NEWFIND must also receive already-published supply-first listings. This
    // closes the gap where a listing was published before a NEWFIND delivery
    // was created, or a previous run stopped after BASE publication.
    const db = createSupabaseAdminClient();
    const { data: publishedSupplyListings, error: publishedSupplyListingsError } = await db
      .from("shop_listings")
      .select("id")
      .eq("published", true)
      .is("bestseller_id", null)
      .order("created_at", { ascending: true })
      .limit(20);
    if (publishedSupplyListingsError) throw new Error(publishedSupplyListingsError.message);

    const listingIds = Array.from(new Set([
      ...discoveredListingIds,
      ...(publishedSupplyListings ?? []).map((row) => String(row.id)),
    ]));

    const base = await publishPublishedListingsToBase(
      Math.max(5, listingIds.length),
    );

    const newfind = await Promise.all(
      listingIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      supplyFirst,
      base,
      newfind,
    });
  } catch (error) {
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
