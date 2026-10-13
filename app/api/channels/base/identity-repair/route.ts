import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TRACER_IDENTIFIER = /^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * Repairs only a missing shop_listings.base_item_id using an exact BASE
 * identifier previously written as TRC-<shop_listings.id>.
 * POST { apply: true, limit: 1000 }; default is a read-only dry run.
 * Never matches by title, price, image, or fuzzy text.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { apply?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const apply = body.apply === true;
  const requestedLimit = Number(body.limit ?? 1000);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
    : 1000;

  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 10 });
    const items = snapshot.items.slice(0, limit).map((item) => ({
      baseItemId: String(item.item_id ?? ""),
      identifier: typeof item.identifier === "string" ? item.identifier.trim() : "",
      visible: item.visible === true || item.visible === 1 || item.visible === "1",
      title: typeof item.title === "string" ? item.title.trim() : "",
      detail: typeof item.detail === "string" ? item.detail.trim() : "",
      price: Number(item.price),
    })).filter((item) => item.baseItemId);

    const candidates = items.map((item) => {
      const match = item.identifier.match(TRACER_IDENTIFIER);
      return { ...item, listingId: match?.[1] ?? null };
    }).filter((item) => item.listingId !== null);

    const idsByListing = new Map<string, typeof candidates>();
    for (const item of candidates) {
      const key = String(item.listingId);
      const list = idsByListing.get(key) ?? [];
      list.push(item);
      idsByListing.set(key, list);
    }

    const listingIds = [...idsByListing.keys()];
    const baseItemIds = [...new Set(items.map((item) => item.baseItemId))];
    const db = createSupabaseAdminClient();

    const [listingResult, existingBaseResult, legacyListingResult] = await Promise.all([
      listingIds.length
        ? db.from("shop_listings").select("id,base_item_id").in("id", listingIds)
        : Promise.resolve({ data: [], error: null }),
      baseItemIds.length
        ? db.from("shop_listings").select("id,base_item_id").in("base_item_id", baseItemIds)
        : Promise.resolve({ data: [], error: null }),
      db.from("shop_listings").select("id,title,description,selling_price").is("base_item_id", null).limit(2000),
    ]);
    if (listingResult.error) throw new Error("base_identity_listing_lookup_failed");
    if (existingBaseResult.error) throw new Error("base_identity_existing_id_lookup_failed");
    if (legacyListingResult.error) throw new Error("base_identity_legacy_candidate_lookup_failed");

    const listingById = new Map((listingResult.data ?? []).map((row) => [String(row.id), row]));
    const listingsByBaseId = new Map<string, string[]>();
    for (const row of existingBaseResult.data ?? []) {
      const key = String(row.base_item_id ?? "");
      const list = listingsByBaseId.get(key) ?? [];
      list.push(String(row.id));
      listingsByBaseId.set(key, list);
    }

    // Legacy candidate audit is deliberately read-only. Exact title/price
    // and title/price/detail fingerprints are diagnostic evidence only; they
    // are never accepted by the repair loop as a linking rule.
    const mappedBaseIds = new Set((existingBaseResult.data ?? []).map((row) => String(row.base_item_id ?? "")));
    const stableItemIds = new Set(candidates.map((item) => item.baseItemId));
    const legacyVisibleItems = items.filter((item) =>
      item.visible && !stableItemIds.has(item.baseItemId) && !mappedBaseIds.has(item.baseItemId)
    );
    const legacyRows = legacyListingResult.data ?? [];
    const candidateLists = legacyVisibleItems.map((item) => {
      const titlePrice = Number.isFinite(item.price) && item.price > 0 && item.title
        ? legacyRows.filter((row) => String(row.title ?? "").trim() === item.title && Number(row.selling_price) === item.price)
        : [];
      const titlePriceDetail = item.detail
        ? titlePrice.filter((row) => String(row.description ?? "").trim() === item.detail)
        : [];
      return { baseItemId: item.baseItemId, titlePrice, titlePriceDetail };
    });
    const titlePriceUseCount = new Map<string, number>();
    const titlePriceDetailUseCount = new Map<string, number>();
    for (const item of candidateLists) {
      for (const row of item.titlePrice) titlePriceUseCount.set(String(row.id), (titlePriceUseCount.get(String(row.id)) ?? 0) + 1);
      for (const row of item.titlePriceDetail) titlePriceDetailUseCount.set(String(row.id), (titlePriceDetailUseCount.get(String(row.id)) ?? 0) + 1);
    }
    const legacyCandidateAudit = {
      matchingRule: "diagnostic only: exact title+price and optionally exact non-empty detail; never auto-links",
      visibleUnmappedWithoutStableIdentifier: legacyVisibleItems.length,
      exactTitlePriceUnique: candidateLists.filter((item) => item.titlePrice.length === 1).length,
      exactTitlePriceAmbiguous: candidateLists.filter((item) => item.titlePrice.length > 1).length,
      exactTitlePriceNoMatch: candidateLists.filter((item) => item.titlePrice.length === 0).length,
      exactTitlePriceGloballyUnique: candidateLists.filter((item) => item.titlePrice.length === 1 && titlePriceUseCount.get(String(item.titlePrice[0].id)) === 1).length,
      exactTitlePriceDetailUnique: candidateLists.filter((item) => item.titlePriceDetail.length === 1).length,
      exactTitlePriceDetailAmbiguous: candidateLists.filter((item) => item.titlePriceDetail.length > 1).length,
      exactTitlePriceDetailGloballyUnique: candidateLists.filter((item) => item.titlePriceDetail.length === 1 && titlePriceDetailUseCount.get(String(item.titlePriceDetail[0].id)) === 1).length,
    };

    const results: Array<{ baseItemId: string; outcome: string; listingId?: string }> = [];
    let repairable = 0;
    let repaired = 0;
    let ambiguous = 0;
    let listingNotFound = 0;
    let listingAlreadyLinked = 0;
    let baseItemAlreadyMapped = 0;

    for (const item of candidates) {
      const listingId = String(item.listingId);
      if ((idsByListing.get(listingId)?.length ?? 0) !== 1) {
        ambiguous += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "duplicate_identifier_ambiguous" });
        continue;
      }

      const listing = listingById.get(listingId);
      if (!listing) {
        listingNotFound += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "listing_not_found" });
        continue;
      }

      const currentBaseId = listing.base_item_id == null ? null : String(listing.base_item_id);
      if (currentBaseId === item.baseItemId) {
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "already_linked" });
        continue;
      }
      if (currentBaseId !== null) {
        listingAlreadyLinked += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "listing_has_different_base_item_id" });
        continue;
      }
      const conflictingRows = (listingsByBaseId.get(item.baseItemId) ?? []).filter((id) => id !== listingId);
      if (conflictingRows.length) {
        baseItemAlreadyMapped += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "base_item_already_mapped_to_other_listing" });
        continue;
      }

      if (!apply) {
        repairable += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "repairable_dry_run" });
        continue;
      }

      const { data: updated, error } = await db
        .from("shop_listings")
        .update({ base_item_id: item.baseItemId })
        .eq("id", listingId)
        .is("base_item_id", null)
        .select("id")
        .maybeSingle();

      if (error) {
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "update_failed" });
      } else if (!updated) {
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "changed_concurrently" });
      } else {
        repaired += 1;
        results.push({ baseItemId: item.baseItemId, listingId, outcome: "base_item_id_repaired" });
      }
    }

    return NextResponse.json({
      ok: true,
      apply,
      readOnly: !apply,
      matchingRule: "BASE identifier exactly equals TRC-<shop_listings.id> UUID",
      snapshotComplete: snapshot.complete,
      scannedBaseItems: items.length,
      stableIdentifierCandidates: candidates.length,
      legacyCandidateAudit,
      repairable,
      repaired,
      ambiguous,
      listingNotFound,
      listingAlreadyLinked,
      baseItemAlreadyMapped,
      publicationChanged: false,
      results: results.slice(0, 100),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
