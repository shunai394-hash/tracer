import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, fetchBaseItemsSnapshot, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COMMERCE_SKU = /^TRC-[0-9A-F]{24}$/i;

/**
 * Hide only an exact duplicate BASE copy. The canonical item remains visible.
 * A duplicate must share an exact TRC SKU with exactly one published channel
 * listing, match the canonical item's title/price/stock, be visible itself,
 * and have no legacy or commerce listing referencing its BASE item ID.
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
    for (const [sku, group] of itemsBySku) {
      if (group.length !== 2) continue;
      const listingRows = rowsBySku.get(sku) ?? [];
      if (listingRows.length !== 1 || listingRows[0].status !== "published") continue;
      const canonicalId = String(listingRows[0].external_product_id ?? "");
      if (!canonicalId || !group.some((item) => String(item.item_id ?? "") === canonicalId)) continue;
      const duplicate = group.find((item) => String(item.item_id ?? "") !== canonicalId);
      if (!duplicate) continue;
      const duplicateId = String(duplicate.item_id ?? "");
      if (!duplicateId || commerceMappedIds.has(duplicateId) || legacyMappedIds.has(duplicateId)) continue;

      const canonical = itemsById.get(canonicalId);
      if (!canonical || canonical.visible !== true || duplicate.visible !== true) continue;
      const title = String(canonical.title ?? "").trim();
      const duplicateTitle = String(duplicate.title ?? "").trim();
      const price = Number(canonical.price);
      const duplicatePrice = Number(duplicate.price);
      const stock = Number(canonical.stock);
      const duplicateStock = Number(duplicate.stock);
      if (!title || title !== duplicateTitle || !Number.isFinite(price) || price <= 0 || price !== duplicatePrice ||
          !Number.isFinite(stock) || stock <= 0 || stock !== duplicateStock) continue;

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
        const detail = String(duplicate?.detail ?? duplicate?.description ?? candidate.title);
        await editBaseItem({
          itemId: candidate.duplicateBaseItemId, title: candidate.title, detail,
          price: candidate.price, stock: 0, visible: false,
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

    return NextResponse.json({
      ok: failed === 0, apply, readOnly: !apply, snapshotComplete: true, scannedBaseItems: items.length,
      duplicateSkuGroups: duplicateGroups.length, duplicateHideCandidates: candidates.length, duplicateHidden: hidden,
      duplicateHideFailed: failed, deferredByLimit: Math.max(0, candidates.length - results.length), results, deleted: 0,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
