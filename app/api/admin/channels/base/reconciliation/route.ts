import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ListingRow = {
  id: string;
  title: string | null;
  product_id: string | null;
  published: boolean | null;
  base_item_id: string | number | null;
  selling_price: number | string | null;
  supplier_name: string | null;
  supplier_listing_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean | null;
  base_publication_status: string | null;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function visibility(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** Read-only reconciliation report. Candidates are evidence only and never auto-mapped. */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => null) as {
      snapshot?: { complete?: unknown; items?: unknown };
    } | null;
    const snapshotItems = body?.snapshot?.items;
    if (
      body?.snapshot?.complete !== true ||
      !Array.isArray(snapshotItems) ||
      snapshotItems.length < 1 ||
      snapshotItems.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    ) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_INCOMPLETE_OR_INVALID", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const typedSnapshotItems = snapshotItems as Record<string, unknown>[];
    const ids = typedSnapshotItems.map((item) => String(item.item_id ?? ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_ID_MISSING_OR_DUPLICATE", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const db = createSupabaseAdminClient();
    const listings: ListingRow[] = [];
    const pageSize = 1000;
    let complete = false;

    for (let page = 0; page < 10; page += 1) {
      const from = page * pageSize;
      const { data, error } = await db
        .from("shop_listings")
        .select("id,title,product_id,published,base_item_id,selling_price,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,inventory,orderable,base_publication_status")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error("TRACER_LISTINGS_READ_FAILED");
      const rows = (data ?? []) as ListingRow[];
      listings.push(...rows);
      if (rows.length < pageSize) {
        complete = true;
        break;
      }
    }

    if (!complete) throw new Error("TRACER_LISTINGS_SCAN_INCOMPLETE");

    const byBaseId = new Map<string, ListingRow[]>();
    const byTitle = new Map<string, ListingRow[]>();
    const byListingId = new Map<string, ListingRow>();
    for (const listing of listings) {
      byListingId.set(String(listing.id).toLowerCase(), listing);
      const baseId = String(listing.base_item_id ?? "").trim();
      if (baseId) {
        const group = byBaseId.get(baseId) ?? [];
        group.push(listing);
        byBaseId.set(baseId, group);
      }
      const title = normalizedTitle(listing.title);
      if (title) {
        const group = byTitle.get(title) ?? [];
        group.push(listing);
        byTitle.set(title, group);
      }
    }

    const items = typedSnapshotItems.map((item) => {
      const baseItemId = String(item.item_id ?? "");
      const title = String(item.title ?? item.name ?? "");
      const key = normalizedTitle(title);
      const identifier = text(item.identifier);
      const stableIdentifierMatch = identifier?.match(/^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
      const stableIdentifierListingId = stableIdentifierMatch?.[1]?.toLowerCase() ?? null;
      const stableIdentifierListing = stableIdentifierListingId ? byListingId.get(stableIdentifierListingId) ?? null : null;
      const exactIdListings = byBaseId.get(baseItemId) ?? [];
      const titleCandidates = key ? (byTitle.get(key) ?? []) : [];
      return {
        baseItemId,
        identifier,
        stableIdentifierListingId,
        stableIdentifierMatchCount: stableIdentifierListing ? 1 : 0,
        stableIdentifierMatches: stableIdentifierListing ? [{
          listingId: stableIdentifierListing.id,
          title: stableIdentifierListing.title,
          published: stableIdentifierListing.published,
          existingBaseItemId: stableIdentifierListing.base_item_id,
          supplierListingId: stableIdentifierListing.supplier_listing_id,
          supplierProductId: stableIdentifierListing.supplier_product_id,
          supplierVariantId: stableIdentifierListing.supplier_variant_id,
          inventory: stableIdentifierListing.inventory,
          orderable: stableIdentifierListing.orderable,
          sellingPrice: stableIdentifierListing.selling_price,
          basePublicationStatus: stableIdentifierListing.base_publication_status,
        }] : [],
        visible: visibility(item.visible),
        title,
        price: item.price ?? null,
        stock: item.stock ?? null,
        exactBaseIdMatchCount: exactIdListings.length,
        exactBaseIdMatches: exactIdListings.map((row) => ({
          listingId: row.id,
          title: row.title,
          published: row.published,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
        })),
        exactTitleCandidateCount: titleCandidates.length,
        exactTitleCandidates: titleCandidates.slice(0, 20).map((row) => ({
          listingId: row.id,
          title: row.title,
          productId: row.product_id,
          published: row.published,
          existingBaseItemId: row.base_item_id,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
          priceDifference: Number.isFinite(Number(item.price)) && Number.isFinite(Number(row.selling_price))
            ? Number(row.selling_price) - Number(item.price)
            : null,
        })),
      };
    });

    const exactMapped = items.filter((item) => item.exactBaseIdMatchCount === 1).length;
    const unmapped = items.filter((item) => item.exactBaseIdMatchCount === 0).length;
    const ambiguous = items.filter((item) => item.exactBaseIdMatchCount > 1).length;
    const titleCandidateCount = items.filter((item) => item.exactTitleCandidateCount > 0).length;
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: "BASE /items + TRACER shop_listings read-only reconciliation",
      complete: complete,
      baseItemCount: typedSnapshotItems.length,
      baseVisibleCount: typedSnapshotItems.filter((item) => visibility(item.visible) === true).length,
      baseHiddenCount: typedSnapshotItems.filter((item) => visibility(item.visible) === false).length,
      tracerListingCount: listings.length,
      exactBaseIdMappedCount: exactMapped,
      baseItemsWithoutExactMappingCount: unmapped,
      baseItemsWithAmbiguousExactMappingCount: ambiguous,
      baseItemsWithExactTitleCandidateCount: titleCandidateCount,
      tracerListingsWithoutBaseItemIdCount: listings.filter((row) => !String(row.base_item_id ?? "").trim()).length,
      duplicateBaseItemIdGroupsInTracer: [...byBaseId.entries()].filter(([, rows]) => rows.length > 1).length,
      note: "Exact-title candidates are unverified suggestions only. This report never writes mappings or changes BASE listings.",
      items,
    };
    const stableIdentifierAudit = items
      .filter((item) => /^TRC-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.identifier ?? "")))
      .map((item) => ({
        baseItemId: item.baseItemId,
        identifier: item.identifier,
        title: item.title,
        visible: item.visible,
        stableIdentifierListingId: item.stableIdentifierListingId,
        stableIdentifierMatchCount: item.stableIdentifierMatchCount,
        stableIdentifierMatches: item.stableIdentifierMatches,
        exactBaseIdMatchCount: item.exactBaseIdMatchCount,
        exactTitleCandidateCount: item.exactTitleCandidateCount,
        exactTitleCandidateListingIds: item.exactTitleCandidates.map((candidate) => candidate.listingId),
      }))
      .sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)));
    console.info("[TRACER BASE STABLE-ID RECONCILIATION]", JSON.stringify({
      generatedAt: report.generatedAt,
      complete: report.complete,
      baseItemCount: report.baseItemCount,
      exactBaseIdMappedCount: report.exactBaseIdMappedCount,
      baseItemsWithoutExactMappingCount: report.baseItemsWithoutExactMappingCount,
      baseItemsWithAmbiguousExactMappingCount: report.baseItemsWithAmbiguousExactMappingCount,
      baseItemsWithExactTitleCandidateCount: report.baseItemsWithExactTitleCandidateCount,
      stableIdentifierCount: stableIdentifierAudit.length,
      stableIdentifierListingMatchedCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1).length,
      stableIdentifierBaseItemIdAlreadyExactCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatches[0]?.existingBaseItemId != null && String(item.stableIdentifierMatches[0].existingBaseItemId) === String(item.baseItemId)).length,
      stableIdentifierBaseItemIdMissingCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1 && item.stableIdentifierMatches[0]?.existingBaseItemId == null).length,
      stableIdentifierBaseItemIdConflictCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1 && item.stableIdentifierMatches[0]?.existingBaseItemId != null && String(item.stableIdentifierMatches[0].existingBaseItemId) !== String(item.baseItemId)).length,
      stableIdentifierAudit,
    }));
    const date = report.generatedAt.slice(0, 10);
    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"tracer-base-reconciliation-" + date + ".json\"",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE RECONCILIATION FAILED]", { stage });
    return NextResponse.json(
      { ok: false, error: stage, complete: false },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
