import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, fetchBaseItemsSnapshot, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COMMERCE_SKU = /^TRC-[0-9A-F]{24}$/i;

// BASE API visibility may be serialized as a boolean, number, or numeric string.
// Treat only documented truthy encodings as visible; unknown values remain blocked.
function isBaseVisible(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/**
 * Hide only an exact duplicate BASE copy. The canonical item remains visible.
 * A duplicate must share an exact TRC SKU with exactly one published channel
 * listing; the canonical item must be present and visible, while the duplicate
 * must be visible and unmapped in both commerce and legacy listings. Stale
 * duplicate title, price, and stock are expected and do not block hiding it.
 * Default is dry-run; apply=true hides only, never deletes.
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
  const requestedLimit = Number(body.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 100;

  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (snapshot.complete !== true || !Array.isArray(snapshot.items)) {
      return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_INCOMPLETE" }, { status: 502 });
    }

    type SnapshotItem = Record<string, unknown>;
    const items: SnapshotItem[] = snapshot.items as unknown as SnapshotItem[];
    const itemsById = new Map<string, SnapshotItem>();
    const itemsBySku = new Map<string, SnapshotItem[]>();
    for (const item of items) {
      const id = String(item.item_id ?? "").trim();
      const sku = String(item.identifier ?? "").trim().toUpperCase();
      if (!id) continue;
      itemsById.set(id, item);
      if (!COMMERCE_SKU.test(sku)) continue;
      const group = itemsBySku.get(sku) ?? [];
      group.push(item);
      itemsBySku.set(sku, group);
    }

    const duplicateGroups = [...itemsBySku.entries()].filter(([, group]) => group.length > 1);
    const duplicateItemIds = [...new Set(duplicateGroups.flatMap(([, group]) => group.map((item) => String(item.item_id ?? "")).filter(Boolean)))];
    const duplicateSkus = duplicateGroups.map(([sku]) => sku);
    const db = createSupabaseAdminClient();

    const skuRows: Array<{ id: string; external_sku: string | null; external_product_id: string | null; status: string | null }> = [];
    for (let offset = 0; offset < duplicateSkus.length; offset += 100) {
      const { data, error } = await db.from("channel_listings")
        .select("id,external_sku,external_product_id,status")
        .eq("channel", "base")
        .in("external_sku", duplicateSkus.slice(offset, offset + 100));
      if (error) throw new Error("base_duplicate_sku_mapping_read_failed");
      skuRows.push(...(data ?? []));
    }

    const itemLinks: Array<{ id: string; external_product_id: string | null }> = [];
    const legacyLinks: Array<{ id: string; base_item_id: string | null }> = [];
    for (let offset = 0; offset < duplicateItemIds.length; offset += 100) {
      const batch = duplicateItemIds.slice(offset, offset + 100);
      const [commerce, legacy] = await Promise.all([
        db.from("channel_listings").select("id,external_product_id").eq("channel", "base").in("external_product_id", batch),
        db.from("shop_listings").select("id,base_item_id").in("base_item_id", batch),
      ]);
      if (commerce.error) throw new Error("base_duplicate_item_link_read_failed");
      if (legacy.error) throw new Error("base_duplicate_legacy_link_read_failed");
      itemLinks.push(...(commerce.data ?? []));
      legacyLinks.push(...(legacy.data ?? []));
    }

    const commerceMappedIds = new Set(itemLinks.map((row) => String(row.external_product_id ?? "")));
    const legacyMappedIds = new Set(legacyLinks.map((row) => String(row.base_item_id ?? "")));
    const rowsBySku = new Map<string, typeof skuRows>();
    for (const row of skuRows) {
      const sku = String(row.external_sku ?? "").trim().toUpperCase();
      const group = rowsBySku.get(sku) ?? [];
      group.push(row);
      rowsBySku.set(sku, group);
    }

    const candidates: Array<{
      sku: string; listingId: string; canonicalBaseItemId: string; duplicateBaseItemId: string;
      title: string; price: number; stock: number;
    }> = [];
    const diagnostics: Array<{
      sku: string; baseItemIds: string[]; baseItemCount: number; listingRowCount: number;
      listingStatuses: string[]; listingExternalProductIds: string[]; visibleItemIds: string[];
      commerceMappedItemIds: string[]; legacyMappedItemIds: string[]; blockers: string[];
    }> = [];
    for (const [sku, group] of duplicateGroups) {
      const ids = group.map((item) => String(item.item_id ?? "")).filter(Boolean);
      const listingRows = rowsBySku.get(sku) ?? [];
      const blockers: string[] = [];
      if (group.length !== 2) blockers.push("base_group_size_not_two");
      if (listingRows.length !== 1) blockers.push(listingRows.length === 0 ? "channel_listing_missing" : "channel_listing_not_unique");
      if (listingRows.length === 1 && listingRows[0].status !== "published") blockers.push("channel_listing_not_published");

      const canonicalId = listingRows.length === 1 ? String(listingRows[0].external_product_id ?? "") : "";
      const canonicalInGroup = Boolean(canonicalId && ids.includes(canonicalId));
      if (listingRows.length === 1 && !canonicalId) blockers.push("canonical_external_product_id_missing");
      else if (listingRows.length === 1 && canonicalId && !canonicalInGroup) blockers.push("canonical_id_not_in_duplicate_group");

      const duplicate = group.length === 2 && canonicalInGroup
        ? group.find((item) => String(item.item_id ?? "") !== canonicalId)
        : undefined;
      const duplicateId = String(duplicate?.item_id ?? "");
      if (duplicate && (!duplicateId || commerceMappedIds.has(duplicateId))) blockers.push("duplicate_has_commerce_mapping");
      if (duplicate && (!duplicateId || legacyMappedIds.has(duplicateId))) blockers.push("duplicate_has_legacy_mapping");

      const canonical = canonicalInGroup ? itemsById.get(canonicalId) : undefined;
      if (canonicalInGroup && (!canonical || !isBaseVisible(canonical.visible))) blockers.push("canonical_not_visible");
      if (duplicate && !isBaseVisible(duplicate.visible)) blockers.push("duplicate_not_visible");
      const title = String(canonical?.title ?? "").trim();
      const price = Number(canonical?.price);
      const stock = Number(canonical?.stock);
      if (canonicalInGroup && !title) blockers.push("canonical_title_missing");
      if (canonicalInGroup && (!Number.isFinite(price) || price <= 0)) blockers.push("canonical_price_invalid");
      if (canonicalInGroup && (!Number.isFinite(stock) || stock <= 0)) blockers.push("canonical_stock_not_positive");

      diagnostics.push({
        sku, baseItemIds: ids, baseItemCount: group.length, listingRowCount: listingRows.length,
        listingStatuses: listingRows.map((row) => String(row.status ?? "null")),
        listingExternalProductIds: listingRows.map((row) => String(row.external_product_id ?? "")),
        visibleItemIds: group.filter((item) => isBaseVisible(item.visible)).map((item) => String(item.item_id ?? "")),
        commerceMappedItemIds: ids.filter((id) => commerceMappedIds.has(id)),
        legacyMappedItemIds: ids.filter((id) => legacyMappedIds.has(id)),
        blockers: [...new Set(blockers)],
      });

      if (blockers.length > 0 || !duplicate || !canonicalInGroup) continue;
      candidates.push({
        sku, listingId: listingRows[0].id, canonicalBaseItemId: canonicalId, duplicateBaseItemId: duplicateId,
        title, price, stock,
      });
    }

    const results: Array<{ sku: string; canonicalBaseItemId: string; duplicateBaseItemId: string; outcome: string; error?: string }> = [];
    let hidden = 0;
    let failed = 0;
    for (const candidate of candidates.slice(0, limit)) {
      if (!apply) {
        results.push({ sku: candidate.sku, canonicalBaseItemId: candidate.canonicalBaseItemId, duplicateBaseItemId: candidate.duplicateBaseItemId, outcome: "dry_run_candidate" });
        continue;
      }
      try {
        const duplicate = itemsById.get(candidate.duplicateBaseItemId);
        const duplicateTitle = String(duplicate?.title ?? "").trim();
        const duplicatePrice = Number(duplicate?.price);
        if (!duplicateTitle || !Number.isFinite(duplicatePrice) || duplicatePrice <= 0) {
          throw new Error("duplicate_metadata_invalid");
        }
        const detail = String(duplicate?.detail ?? duplicate?.description ?? duplicateTitle);
        await editBaseItem({
          itemId: candidate.duplicateBaseItemId, title: duplicateTitle, detail,
          price: duplicatePrice, stock: 0, visible: false,
        });
        hidden += 1;
        results.push({ sku: candidate.sku, canonicalBaseItemId: candidate.canonicalBaseItemId, duplicateBaseItemId: candidate.duplicateBaseItemId, outcome: "duplicate_hidden" });
      } catch (error) {
        failed += 1;
        results.push({
          sku: candidate.sku, canonicalBaseItemId: candidate.canonicalBaseItemId, duplicateBaseItemId: candidate.duplicateBaseItemId,
          outcome: "hide_failed", error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
    }

    // Report only normalized visibility value categories, never raw product fields.
    // This distinguishes a real all-hidden catalog from an API shape/encoding change.
    const visibilityValueKinds = items.reduce<Record<string, number>>((summary, item) => {
      const value = item.visible;
      let kind: string;
      if (value === undefined) kind = "missing";
      else if (value === null) kind = "null";
      else if (typeof value === "boolean") kind = value ? "boolean_true" : "boolean_false";
      else if (typeof value === "number") kind = value === 1 ? "number_1" : value === 0 ? "number_0" : "number_other";
      else if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        kind = normalized === "1" ? "string_1"
          : normalized === "0" ? "string_0"
          : normalized === "true" ? "string_true"
          : normalized === "false" ? "string_false"
          : normalized === "" ? "string_empty" : "string_other";
      } else if (Array.isArray(value)) kind = "array";
      else if (typeof value === "object") kind = "object";
      else kind = "other";
      summary[kind] = (summary[kind] ?? 0) + 1;
      return summary;
    }, {});

    return NextResponse.json({
      ok: failed === 0, apply, readOnly: !apply, snapshotComplete: true, scannedBaseItems: items.length,
      visibilityValueKinds,
      duplicateSkuGroups: duplicateGroups.length, duplicateHideCandidates: candidates.length, duplicateHidden: hidden,
      duplicateHideFailed: failed, deferredByLimit: Math.max(0, candidates.length - results.length), results,
      diagnosticSummary: diagnostics.reduce<Record<string, number>>((summary, group) => {
        for (const blocker of group.blockers) summary[blocker] = (summary[blocker] ?? 0) + 1;
        return summary;
      }, {}),
      diagnostics, deleted: 0,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
