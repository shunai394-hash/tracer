import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";
import { classifyBaseIdentifier, decideCommerceSkuLink } from "@/lib/channels/base-item-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TRACER_IDENTIFIER = /^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CREATE_ID_MARKER = /^base_create_id_persist_failed:([^:]+)(?::|$)/;

/**
 * Repairs only a missing shop_listings.base_item_id using deterministic evidence:
 * an exact BASE identifier TRC-<shop_listings.id>, or the exact BASE item_id
 * captured in the row's base_create_id_persist_failed marker after BASE created
 * the item but the DB write failed. Default is a read-only dry run.
 * Never matches by title, price, image, or fuzzy text; publication state is untouched.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { apply?: unknown; repairStaleExternalIds?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const apply = body.apply === true;
  const repairStaleExternalIds = body.repairStaleExternalIds === true;
  const requestedLimit = Number(body.limit ?? 1000);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
    : 1000;

  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (!snapshot.complete) {
      return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_INCOMPLETE" }, { status: 502 });
    }
    // Evaluate the whole snapshot; `limit` only bounds how many rows one apply call writes.
    const items = snapshot.items.map((item) => ({
      baseItemId: String(item.item_id ?? ""),
      identifier: typeof item.identifier === "string" ? item.identifier.trim() : "",
    })).filter((item) => item.baseItemId);
    const itemIds = new Set(items.map((item) => item.baseItemId));

    const identityCandidates = items.flatMap((item) => {
      const match = item.identifier.match(TRACER_IDENTIFIER);
      return match?.[1] ? [{ baseItemId: item.baseItemId, listingId: match[1], source: "exact_identifier" as const }] : [];
    });

    const db = createSupabaseAdminClient();
    // This marker stores the exact external ID returned by BASE when item creation
    // succeeded but persistence of base_item_id failed. It is independent evidence.
    const { data: markerRows, error: markerError } = await db
      .from("shop_listings")
      .select("id,base_item_id,base_last_error")
      .is("base_item_id", null)
      .like("base_last_error", "base_create_id_persist_failed:%")
      .limit(5000);
    if (markerError) throw new Error("base_identity_recovery_marker_lookup_failed");

    const recoveryCandidates = (markerRows ?? []).flatMap((row) => {
      const marker = String(row.base_last_error ?? "").match(CREATE_ID_MARKER);
      const baseItemId = marker?.[1]?.trim() ?? "";
      return baseItemId && itemIds.has(baseItemId)
        ? [{ baseItemId, listingId: String(row.id), source: "persisted_create_marker" as const }]
        : [];
    });

    // Deduplicate only identical (BASE item ID, listing ID) evidence pairs.
    const candidatesByPair = new Map<string, {
      baseItemId: string;
      listingId: string;
      sources: Set<"exact_identifier" | "persisted_create_marker">;
    }>();
    for (const candidate of [...identityCandidates, ...recoveryCandidates]) {
      const key = JSON.stringify([candidate.baseItemId, candidate.listingId]);
      const existing = candidatesByPair.get(key) ?? {
        baseItemId: candidate.baseItemId,
        listingId: candidate.listingId,
        sources: new Set<"exact_identifier" | "persisted_create_marker">(),
      };
      existing.sources.add(candidate.source);
      candidatesByPair.set(key, existing);
    }
    const candidates = [...candidatesByPair.values()];

    const idsByListing = new Map<string, typeof candidates>();
    const idsByBaseItem = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const byListing = idsByListing.get(candidate.listingId) ?? [];
      byListing.push(candidate);
      idsByListing.set(candidate.listingId, byListing);
      const byBase = idsByBaseItem.get(candidate.baseItemId) ?? [];
      byBase.push(candidate);
      idsByBaseItem.set(candidate.baseItemId, byBase);
    }

    const listingIds = [...new Set(candidates.map((item) => item.listingId))];
    const baseItemIds = [...new Set(candidates.map((item) => item.baseItemId))];
    const [listingResult, existingBaseResult] = await Promise.all([
      listingIds.length
        ? db.from("shop_listings").select("id,base_item_id").in("id", listingIds)
        : Promise.resolve({ data: [], error: null }),
      baseItemIds.length
        ? db.from("shop_listings").select("id,base_item_id").in("base_item_id", baseItemIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (listingResult.error) throw new Error("base_identity_listing_lookup_failed");
    if (existingBaseResult.error) throw new Error("base_identity_existing_id_lookup_failed");

    const listingById = new Map((listingResult.data ?? []).map((row) => [String(row.id), row]));
    const listingsByBaseId = new Map<string, string[]>();
    for (const row of existingBaseResult.data ?? []) {
      const key = String(row.base_item_id ?? "");
      const list = listingsByBaseId.get(key) ?? [];
      list.push(String(row.id));
      listingsByBaseId.set(key, list);
    }

    const results: Array<{ baseItemId: string; outcome: string; listingId?: string; source?: string[] }> = [];
    let repairable = 0;
    let repaired = 0;
    let ambiguous = 0;
    let listingNotFound = 0;
    let listingAlreadyLinked = 0;
    let baseItemAlreadyMapped = 0;

    for (const item of candidates) {
      const listingId = item.listingId;
      const sources = [...item.sources].sort();
      if ((idsByListing.get(listingId)?.length ?? 0) !== 1 || (idsByBaseItem.get(item.baseItemId)?.length ?? 0) !== 1) {
        ambiguous += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "identity_evidence_ambiguous" });
        continue;
      }

      const listing = listingById.get(listingId);
      if (!listing) {
        listingNotFound += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "listing_not_found" });
        continue;
      }

      const currentBaseId = listing.base_item_id == null ? null : String(listing.base_item_id);
      if (currentBaseId === item.baseItemId) {
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "already_linked" });
        continue;
      }
      if (currentBaseId !== null) {
        listingAlreadyLinked += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "listing_has_different_base_item_id" });
        continue;
      }
      const conflictingRows = (listingsByBaseId.get(item.baseItemId) ?? []).filter((id) => id !== listingId);
      if (conflictingRows.length) {
        baseItemAlreadyMapped += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "base_item_already_mapped_to_other_listing" });
        continue;
      }

      if (!apply) {
        repairable += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "repairable_dry_run" });
        continue;
      }

      if (repaired >= limit) {
        repairable += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "repairable_deferred_by_limit" });
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
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "update_failed" });
      } else if (!updated) {
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "changed_concurrently" });
      } else {
        repaired += 1;
        results.push({ baseItemId: item.baseItemId, listingId, source: sources, outcome: "base_item_id_repaired" });
      }
    }

    const skuGroups = new Map<string, string[]>();
    for (const item of items) {
      const identity = classifyBaseIdentifier(item.identifier);
      if (identity.kind !== "commerce_sku") continue;
      const group = skuGroups.get(identity.sku) ?? [];
      group.push(item.baseItemId);
      skuGroups.set(identity.sku, group);
    }
    const skuList = [...skuGroups.keys()];
    const skuListings: Array<{ id: string; external_sku: string | null; external_product_id: string | null }> = [];
    for (let offset = 0; offset < skuList.length; offset += 100) {
      const { data, error } = await db.from("channel_listings")
        .select("id,external_sku,external_product_id")
        .eq("channel", "base")
        .in("external_sku", skuList.slice(offset, offset + 100));
      if (error) throw new Error("base_commerce_sku_lookup_failed");
      skuListings.push(...(data ?? []));
    }
    const listingsBySku = new Map<string, Array<{ id: string; externalProductId: string | null }>>();
    for (const row of skuListings) {
      const sku = String(row.external_sku ?? "").toUpperCase();
      const group = listingsBySku.get(sku) ?? [];
      group.push({ id: String(row.id), externalProductId: row.external_product_id == null ? null : String(row.external_product_id) });
      listingsBySku.set(sku, group);
    }
    const candidateBaseIds = [...new Set([...skuGroups.values()].flat())];
    const existingBaseLinks: Array<{ id: string; external_product_id: string | null }> = [];
    for (let offset = 0; offset < candidateBaseIds.length; offset += 100) {
      const { data, error } = await db.from("channel_listings")
        .select("id,external_product_id")
        .eq("channel", "base")
        .in("external_product_id", candidateBaseIds.slice(offset, offset + 100));
      if (error) throw new Error("base_commerce_existing_link_lookup_failed");
      existingBaseLinks.push(...(data ?? []));
    }
    const listingIdsByBaseItem = new Map<string, string[]>();
    for (const row of existingBaseLinks) {
      const key = String(row.external_product_id ?? "");
      const group = listingIdsByBaseItem.get(key) ?? [];
      group.push(String(row.id));
      listingIdsByBaseItem.set(key, group);
    }
    let commerceRepairable = 0;
    let commerceRepaired = 0;
    for (const [sku, baseItemIds] of skuGroups) {
      for (const baseItemId of baseItemIds) {
        const skuRows = listingsBySku.get(sku) ?? [];
        const currentExternalId = skuRows.length === 1 ? skuRows[0].externalProductId : null;
        const decision = decideCommerceSkuLink({
          baseItemId,
          listingsForSku: skuRows,
          otherBaseItemIdsWithSameSku: baseItemIds.filter((id) => id !== baseItemId),
          listingIdsAlreadyUsingBaseItem: listingIdsByBaseItem.get(baseItemId) ?? [],
          currentExternalIdExists: currentExternalId ? itemIds.has(currentExternalId) : undefined,
        });
        const canRepair = decision.outcome === "repairable" || decision.outcome === "repairable_stale_external_id";
        if (!canRepair || !decision.listingId) {
          if (decision.outcome === "ambiguous_sku" || decision.outcome === "ambiguous_base_item" || decision.outcome === "base_item_already_mapped") {
            ambiguous += 1;
          }
          continue;
        }
        const source = decision.outcome === "repairable_stale_external_id"
          ? ["exact_commerce_sku", "stale_external_id_absent_from_complete_snapshot"]
          : ["exact_commerce_sku"];
        if (!apply) {
          commerceRepairable += 1;
          repairable += 1;
          results.push({ baseItemId, listingId: decision.listingId, source, outcome: "repairable_dry_run" });
          continue;
        }
        if (decision.outcome === "repairable_stale_external_id" && !repairStaleExternalIds) {
          commerceRepairable += 1;
          repairable += 1;
          results.push({ baseItemId, listingId: decision.listingId, source, outcome: "stale_external_id_repair_requires_explicit_flag" });
          continue;
        }
        if (repaired >= limit) {
          commerceRepairable += 1;
          repairable += 1;
          results.push({ baseItemId, listingId: decision.listingId, source, outcome: "repairable_deferred_by_limit" });
          continue;
        }
        let updateQuery = db.from("channel_listings")
          .update({ external_product_id: baseItemId, updated_at: new Date().toISOString() })
          .eq("id", decision.listingId)
          .eq("channel", "base");
        if (decision.outcome === "repairable_stale_external_id" && decision.previousExternalProductId) {
          updateQuery = updateQuery.eq("external_product_id", decision.previousExternalProductId);
        } else {
          updateQuery = updateQuery.is("external_product_id", null);
        }
        const { data: updated, error } = await updateQuery.select("id").maybeSingle();
        if (error || !updated) {
          results.push({ baseItemId, listingId: decision.listingId, source, outcome: error ? "update_failed" : "changed_concurrently" });
        } else {
          commerceRepaired += 1;
          repaired += 1;
          results.push({
            baseItemId,
            listingId: decision.listingId,
            source,
            outcome: decision.outcome === "repairable_stale_external_id" ? "commerce_stale_external_id_repaired" : "commerce_external_id_repaired",
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      apply,
      readOnly: !apply,
      matchingRules: [
        "BASE identifier exactly equals TRC-<shop_listings.id>",
        "BASE item_id exactly equals the same row's base_create_id_persist_failed marker",
        "Exact unique TRC commerce SKU may repair a missing channel ID",
        "A stale channel ID may be rebound only when absent from a complete BASE snapshot, the exact SKU is unique, and the new BASE item ID is not already mapped",
      ],
      repairStaleExternalIds,
      snapshotComplete: snapshot.complete,
      scannedBaseItems: items.length,
      stableIdentifierCandidates: identityCandidates.length,
      recoveryMarkerCandidates: recoveryCandidates.length,
      uniqueEvidencePairs: candidates.length,
      repairable,
      repaired,
      commerceRepairable,
      commerceRepaired,
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
