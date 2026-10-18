import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { editBaseItem, fetchBaseItemsSnapshot, getBaseItemDetail, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type BaseItem = Record<string, unknown>;
type Plan = { sku: string; itemId: string; oldPrice: number; targetPrice: number; visible: boolean; stock: number; title: string; detail: string };

function asVisible(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}
function positivePrice(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * For exact duplicate TRC SKU groups, align all live BASE prices to the
 * highest currently observed price. Read-only by default; apply is explicit.
 * Does not create/delete items or change SKU, visibility, or stock.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });

  const body = await request.json().catch(() => ({})) as { apply?: unknown; limit?: unknown };
  const apply = body.apply === true;
  const requested = Number(body.limit ?? 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(25, Math.floor(requested))) : 10;

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (!snapshot.complete) return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_INCOMPLETE", readOnly: !apply }, { status: 502 });

    const groups = new Map<string, BaseItem[]>();
    for (const item of snapshot.items) {
      const sku = String(item.identifier ?? "").trim().toUpperCase();
      if (!/^TRC-[0-9A-F]{24}$/.test(sku)) continue;
      const group = groups.get(sku) ?? [];
      group.push(item);
      groups.set(sku, group);
    }

    const duplicateGroups = [...groups.entries()].filter(([, items]) => items.length > 1);
    const plans: Plan[] = [];
    const rejected: Array<{ sku: string; itemId: string; reason: string }> = [];
    for (const [sku, items] of duplicateGroups) {
      const ids = items.map(x => String(x.item_id ?? "").trim());
      if (ids.some(x => !/^\d+$/.test(x)) || new Set(ids).size !== ids.length) {
        for (const item of items) rejected.push({ sku, itemId: String(item.item_id ?? ""), reason: "item_id_missing_or_duplicate" });
        continue;
      }
      const prices = items.map(x => positivePrice(x.price));
      if (prices.some(x => x === null)) {
        for (const item of items) rejected.push({ sku, itemId: String(item.item_id ?? ""), reason: "price_missing_or_invalid" });
        continue;
      }
      const targetPrice = Math.max(...prices as number[]);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const oldPrice = prices[i] as number;
        if (oldPrice >= targetPrice) continue;
        const visible = asVisible(item.visible);
        const stock = Number(item.stock);
        const title = typeof item.title === "string" ? item.title : "";
        const detail = typeof item.detail === "string" ? item.detail : "";
        if (visible === null || !Number.isFinite(stock) || stock < 0 || !title.trim() || typeof item.detail !== "string") {
          rejected.push({ sku, itemId: ids[i], reason: "live_item_state_incomplete" });
          continue;
        }
        plans.push({ sku, itemId: ids[i], oldPrice, targetPrice, visible, stock: Math.floor(stock), title, detail });
      }
    }

    const selected = plans.slice(0, limit);
    const results: Array<Record<string, unknown>> = [];
    if (apply) {
      for (const plan of selected) {
        try {
          const before = await getBaseItemDetail(plan.itemId);
          const beforeSku = String(before.identifier ?? "").trim().toUpperCase();
          const beforePrice = positivePrice(before.price);
          const beforeVisible = asVisible(before.visible);
          const beforeStock = Number(before.stock);
          if (beforeSku !== plan.sku || beforePrice !== plan.oldPrice || beforeVisible !== plan.visible ||
              !Number.isFinite(beforeStock) || Math.floor(beforeStock) !== plan.stock ||
              typeof before.title !== "string" || typeof before.detail !== "string") {
            results.push({ ...plan, ok: false, outcome: "live_item_changed_after_snapshot" });
            continue;
          }
          if (beforePrice >= plan.targetPrice) {
            results.push({ ...plan, ok: true, outcome: "already_at_or_above_target" });
            continue;
          }
          await editBaseItem({
            itemId: plan.itemId,
            title: String(before.title),
            detail: String(before.detail),
            price: plan.targetPrice,
            stock: plan.stock,
            visible: plan.visible,
          });
          const after = await getBaseItemDetail(plan.itemId);
          const afterPrice = positivePrice(after.price);
          const afterVisible = asVisible(after.visible);
          const afterStock = Number(after.stock);
          const ok = String(after.identifier ?? "").trim().toUpperCase() === plan.sku &&
            afterPrice === plan.targetPrice && afterVisible === plan.visible &&
            Number.isFinite(afterStock) && Math.floor(afterStock) === plan.stock;
          results.push({
            ...plan, ok, outcome: ok ? "price_aligned_and_verified" : "readback_mismatch",
            actualPrice: afterPrice, actualVisible: afterVisible,
            actualStock: Number.isFinite(afterStock) ? Math.floor(afterStock) : null,
          });
        } catch (error) {
          results.push({ ...plan, ok: false, outcome: "update_failed", error: error instanceof Error ? error.message.split(":")[0] : "update_failed" });
        }
      }
    }

    const failed = results.filter(x => x.ok !== true).length;
    return NextResponse.json({
      ok: !apply || failed === 0, apply, readOnly: !apply, snapshotComplete: true,
      scannedBaseItems: snapshot.items.length, duplicateSkuGroups: duplicateGroups.length,
      candidatePriceUpdates: plans.length, selected: selected.length, updatedAndVerified: results.filter(x => x.outcome === "price_aligned_and_verified").length,
      failed, deferredByLimit: Math.max(0, plans.length - selected.length),
      groupSummaries: duplicateGroups.map(([sku, items]) => ({
        sku, itemIds: items.map(x => String(x.item_id ?? "")),
        prices: items.map(x => ({ itemId: String(x.item_id ?? ""), price: positivePrice(x.price) })),
        targetPrice: Math.max(...items.map(x => positivePrice(x.price) ?? 0)),
      })),
      selectedPlans: apply ? results : selected, rejected: rejected.slice(0, 100),
    }, { status: apply && failed ? 207 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.split(":")[0] : "BASE_DUPLICATE_SKU_PRICE_ALIGNMENT_FAILED", readOnly: !apply }, { status: 502 });
  }
}
