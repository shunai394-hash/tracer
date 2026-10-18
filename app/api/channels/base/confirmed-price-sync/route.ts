import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, fetchBaseItemsSnapshot, getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { decideConfirmedPriceSync, type BaseChannelListing } from "@/lib/channels/base-actual-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function visibleOf(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/**
 * Pushes channel_listings.selling_price onto BASE only when the item ID and SKU
 * already identify one listing. Title, description, stock, and visibility are
 * copied from the live BASE item and checked again after the edit.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  let body: { apply?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const requested = Number(body.limit ?? 25);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(25, Math.floor(requested))) : 25;

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 50 });
    if (!snapshot.complete) {
      return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_INCOMPLETE", pages: snapshot.pages }, { status: 502 });
    }
    const db = createSupabaseAdminClient();
    const listings: BaseChannelListing[] = [];
    for (let page = 0; page < 20; page += 1) {
      const from = page * 1000;
      const { data, error } = await db.from("channel_listings")
        .select("id,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
        .eq("channel", "base")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error("BASE_PRICE_SYNC_LISTINGS_READ_FAILED:" + (error.code ?? "unknown"));
      listings.push(...(data ?? []).map((row) => ({
        id: String(row.id),
        variantId: String(row.variant_id),
        externalProductId: row.external_product_id == null ? null : String(row.external_product_id),
        externalVariantId: row.external_variant_id == null ? null : String(row.external_variant_id),
        externalSku: row.external_sku == null ? null : String(row.external_sku),
        sellingPrice: row.selling_price == null ? null : Number(row.selling_price),
        status: row.status == null ? null : String(row.status),
      })));
      if ((data ?? []).length < 1000) break;
    }

    const liveSkuCounts = new Map<string, number>();
    for (const item of snapshot.items) {
      const sku = typeof item.identifier === "string" ? item.identifier.trim().toUpperCase() : "";
      if (sku) liveSkuCounts.set(sku, (liveSkuCounts.get(sku) ?? 0) + 1);
    }
    const plans = snapshot.items.flatMap((item) => {
      const baseItemId = String(item.item_id ?? "");
      const baseIdentifier = typeof item.identifier === "string" ? item.identifier.trim() : null;
      // SKU-only price correction is safe only when that SKU occurs exactly
      // once in the complete BASE snapshot; it never changes the stored ID.
      if (!baseIdentifier || liveSkuCounts.get(baseIdentifier.toUpperCase()) !== 1) return [];
      const decision = decideConfirmedPriceSync({
        baseItemId,
        baseIdentifier,
        basePrice: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
        listings,
      });
      if (!decision.ok) return [];
      return [{
        baseItemId,
        listingId: decision.listingId,
        basePrice: Number(item.price),
        canonicalPrice: decision.canonicalPrice,
        baseIdentifier,
      }];
    });

    const results: Array<Record<string, unknown>> = [];
    let updated = 0;
    let failed = 0;
    const selected = plans.slice(0, limit);
    if (apply) {
      for (const plan of selected) {
        try {
          const before = await getBaseItemDetail(plan.baseItemId);
          const title = text(before.title);
          const detail = text(before.detail);
          const stock = Number(before.stock);
          const visible = visibleOf(before.visible);
          const identifier = typeof before.identifier === "string" ? before.identifier.trim() : "";
          if (!title || detail === null || !Number.isFinite(stock) || stock < 0 || visible === null) {
            failed += 1;
            results.push({ ...plan, outcome: "live_item_state_incomplete" });
            continue;
          }
          if (identifier.toUpperCase() !== plan.baseIdentifier.toUpperCase()) {
            failed += 1;
            results.push({ ...plan, outcome: "live_sku_changed" });
            continue;
          }
          if (Math.round(Number(before.price)) === plan.canonicalPrice) {
            results.push({ ...plan, outcome: "already_matched_on_readback" });
            continue;
          }
          await editBaseItem({
            itemId: plan.baseItemId,
            title,
            detail,
            price: plan.canonicalPrice,
            stock,
            visible,
          });
          const after = await getBaseItemDetail(plan.baseItemId);
          const afterVisible = visibleOf(after.visible);
          const afterStock = Number(after.stock);
          const afterPrice = Number(after.price);
          const preserved = afterVisible === visible && afterStock === stock && Math.round(afterPrice) === plan.canonicalPrice;
          const readback = {
            beforeVisible: visible,
            beforeStock: stock,
            afterPrice: Number.isFinite(afterPrice) ? afterPrice : null,
            afterVisible,
            afterStock: Number.isFinite(afterStock) ? afterStock : null,
          };
          if (!preserved) {
            failed += 1;
            results.push({ ...plan, outcome: "readback_mismatch", ...readback });
            continue;
          }
          updated += 1;
          results.push({ ...plan, outcome: "price_synced", ...readback });
        } catch (error) {
          failed += 1;
          results.push({
            ...plan,
            outcome: "update_failed",
            error: error instanceof Error ? error.message.slice(0, 180) : "update_failed",
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      apply,
      readOnly: !apply,
      snapshotComplete: true,
      pages: snapshot.pages,
      scannedBaseItems: snapshot.items.length,
      confirmedPriceDifferences: plans.length,
      deferredByLimit: Math.max(0, plans.length - limit),
      updated,
      failed,
      publicationChanged: results.some((row) => row.outcome === "readback_mismatch" && row.afterVisible !== row.beforeVisible),
      stockChanged: results.some((row) => row.outcome === "readback_mismatch" && row.afterStock !== row.beforeStock),
      plans: apply ? results : selected,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "BASE_CONFIRMED_PRICE_SYNC_FAILED",
    }, { status: 502 });
  }
}
