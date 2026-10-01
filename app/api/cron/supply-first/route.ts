import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { evaluateSupplierAutoEligibility } from "@/lib/procurement/auto-eligibility";

export const runtime = "nodejs";
export const maxDuration = 300;
const DISCOVERY_BUDGET_MS = 180_000;
const DISCOVERY_BATCH_SIZE = 5;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();
    const eligibility = evaluateSupplierAutoEligibility("cj");
    if (!eligibility.eligible) return NextResponse.json({ ok: true, skipped: true, reason: eligibility.reason, missing: eligibility.missing, eligibility });

    const supplyFirst = await discoverAndCreateCjSupply(DISCOVERY_BATCH_SIZE, { deadlineAt: startedAt + DISCOVERY_BUDGET_MS });
    const discoveredListingIds = supplyFirst.items.map((item) => String(item.listingId ?? "")).filter(Boolean);
    const db = createSupabaseAdminClient();
    const { data: publishedSupplyListings, error: publishedSupplyListingsError } = await db.from("shop_listings").select("id").eq("published", true).is("bestseller_id", null).order("created_at", { ascending: true }).limit(20);
    if (publishedSupplyListingsError) throw new Error(publishedSupplyListingsError.message);
    const listingIds = Array.from(new Set([...discoveredListingIds, ...(publishedSupplyListings ?? []).map((row) => String(row.id))]));
    const base = await publishPublishedListingsToBase(Math.max(5, listingIds.length));
    console.log("[TRACER BASE PUBLISH RESULT]", JSON.stringify({ attempted: base.attempted, published: base.published, skipped: base.skipped, failed: base.failed, results: base.results }));
    const newfind = await Promise.all(listingIds.map((listingId) => promoteShopListingToNewfind(listingId).catch((error) => ({ configured: true, sent: false, eventId: `tracer-shop-listing:${listingId}`, status: null, detail: error instanceof Error ? error.message : String(error) }))));
    return NextResponse.json({ ok: true, elapsedMs: Date.now() - startedAt, supplyFirst, base, newfind });
  } catch (error) {
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
