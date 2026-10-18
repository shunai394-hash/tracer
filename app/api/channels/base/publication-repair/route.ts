import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  BASE_ITEMS_MAX_PAGES,
  deleteAllowlistedStaleBaseItem,
  editBaseItem,
  fetchBaseItemsSnapshot,
  getBaseItemDetail,
  getBaseOrderDetail,
  isBaseConfigured,
  listBaseOrders,
} from "@/lib/channels/base";
import {
  ERROR_HIDDEN_LEAVE,
  HIDDEN_DUPLICATE_DELETES,
  VISIBLE_NONCANONICAL_HIDES,
  assessErrorHidden,
  assessHiddenDelete,
  assessVisibleHide,
  type PublicationRepairItem,
} from "@/lib/channels/base-publication-repair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONFIRMATION = "REPAIR_ELEVEN_BASE_PUBLICATION_MISMATCHES";
const ACTION_IDS = [
  ...HIDDEN_DUPLICATE_DELETES.map((pair) => pair.staleId),
  ...VISIBLE_NONCANONICAL_HIDES.map((pair) => pair.staleId),
];

function asItem(item: Record<string, unknown>): PublicationRepairItem {
  const visible = item.visible === true || item.visible === 1 || item.visible === "1"
    ? true
    : item.visible === false || item.visible === 0 || item.visible === "0" ? false : null;
  const price = Number(item.price);
  return {
    itemId: String(item.item_id ?? "").trim(),
    sku: typeof item.identifier === "string" ? item.identifier.trim() : null,
    visible,
    price: Number.isFinite(price) ? price : null,
  };
}

async function readDetail(itemId: string): Promise<PublicationRepairItem | "absent"> {
  try {
    return asItem(await getBaseItemDetail(itemId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("HTTP_404")) return "absent";
    throw error;
  }
}

async function orderReferences(ids: string[]) {
  const wanted = new Set(ids);
  const matches: string[] = [];
  let scanned = 0;
  let offset = 0;
  const deadline = Date.now() + 20_000;
  for (let page = 0; page < 8 && Date.now() < deadline; page += 1) {
    const orders = await listBaseOrders({ limit: 100, offset });
    if (orders.length === 0) return { scanned, complete: true, matches };
    for (const order of orders) {
      if (Date.now() >= deadline) return { scanned, complete: false, matches };
      const detail = await getBaseOrderDetail(order.unique_key);
      scanned += 1;
      if ((detail.order_items ?? []).some((item) => wanted.has(String(item.item_id ?? "")))) {
        matches.push(order.unique_key);
      }
    }
    if (orders.length < 100) return { scanned, complete: true, matches };
    offset += orders.length;
  }
  return { scanned, complete: false, matches };
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as { apply?: unknown; confirmation?: unknown };
  const apply = body.apply === true;
  if (apply && body.confirmation !== CONFIRMATION) {
    return NextResponse.json({ ok: false, error: "explicit_confirmation_required" }, { status: 400 });
  }

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (!snapshot.complete) throw new Error("BASE_SNAPSHOT_INCOMPLETE");
    const items = new Map(snapshot.items.map((item) => {
      const view = asItem(item as Record<string, unknown>);
      return [view.itemId, view] as const;
    }));
    const db = createSupabaseAdminClient();
    const skus = [
      ...HIDDEN_DUPLICATE_DELETES.map((pair) => pair.sku),
      ...VISIBLE_NONCANONICAL_HIDES.map((pair) => pair.sku),
      ...ERROR_HIDDEN_LEAVE.map((item) => item.sku),
    ];
    const { data: listings, error } = await db.from("channel_listings")
      .select("id,external_product_id,external_sku,status")
      .eq("channel", "base")
      .in("external_sku", skus);
    if (error) throw new Error("PUBLICATION_REPAIR_LISTING_READ_FAILED");
    const bySku = new Map<string, Array<{ externalId: string | null; status: string | null }>>();
    for (const row of listings ?? []) {
      const sku = String(row.external_sku ?? "");
      const group = bySku.get(sku) ?? [];
      group.push({
        externalId: row.external_product_id == null ? null : String(row.external_product_id),
        status: row.status == null ? null : String(row.status),
      });
      bySku.set(sku, group);
    }
    const listingFor = (sku: string) => {
      const group = bySku.get(sku) ?? [];
      return group.length === 1 ? group[0] : null;
    };

    const deletes = HIDDEN_DUPLICATE_DELETES.map((pair) => ({
      ...pair,
      action: "delete_hidden_duplicate" as const,
      ...assessHiddenDelete(pair, items, listingFor(pair.sku)?.externalId ?? null),
    }));
    const hides = VISIBLE_NONCANONICAL_HIDES.map((pair) => ({
      ...pair,
      action: "hide_visible_noncanonical" as const,
      ...assessVisibleHide(pair, items, listingFor(pair.sku)?.externalId ?? null),
    }));
    const errors = ERROR_HIDDEN_LEAVE.map((target) => ({
      ...target,
      action: "leave_db_error_base_already_hidden" as const,
      ...assessErrorHidden(target, items, listingFor(target.sku)),
    }));
    const orders = await orderReferences(ACTION_IDS);
    const { data: linked, error: linkError } = await db.from("channel_listings")
      .select("external_product_id")
      .eq("channel", "base")
      .in("external_product_id", ACTION_IDS);
    if (linkError) throw new Error("PUBLICATION_REPAIR_STALE_LINK_CHECK_FAILED");
    const listingReferences = (linked ?? []).map((row) => String(row.external_product_id));
    const blocked = deletes.some((row) => !row.ok) || hides.some((row) => !row.ok) || errors.some((row) => !row.ok)
      || orders.complete !== true || orders.matches.length > 0 || listingReferences.length > 0;

    if (!apply || blocked) {
      return NextResponse.json({
        ok: !blocked,
        readOnly: true,
        snapshotComplete: true,
        itemCount: snapshot.items.length,
        deletes,
        hides,
        errorItems: errors,
        orderScan: orders,
        listingReferences,
        blocked,
        message: blocked
          ? "Repair refused. A target no longer matches the verified pair, or an order or listing still references it."
          : "Dry run only. No BASE item was deleted or hidden.",
      }, { status: blocked ? 409 : 200 });
    }

    const results: Array<{ itemId: string; outcome: string }> = [];
    for (const pair of HIDDEN_DUPLICATE_DELETES) {
      const before = new Map<string, PublicationRepairItem>();
      for (const id of [pair.staleId, pair.canonicalId]) {
        const detail = await readDetail(id);
        if (detail === "absent") throw new Error(`DELETE_PRECHECK_ITEM_ABSENT:${id}`);
        before.set(detail.itemId, detail);
      }
      const decision = assessHiddenDelete(pair, before, listingFor(pair.sku)?.externalId ?? null);
      if (!decision.ok) throw new Error(`DELETE_PRECHECK_FAILED:${pair.staleId}:${decision.reason}`);
      await deleteAllowlistedStaleBaseItem(pair.staleId);
      if (await readDetail(pair.staleId) !== "absent") throw new Error(`DELETE_READBACK_STALE_ITEM_STILL_PRESENT:${pair.staleId}`);
      const canonical = await readDetail(pair.canonicalId);
      if (canonical === "absent") throw new Error(`CANONICAL_READBACK_FAILED:${pair.canonicalId}`);
      const after = assessHiddenDelete(pair, new Map([[pair.canonicalId, canonical], [pair.staleId, { itemId: pair.staleId, sku: pair.sku, visible: false, price: pair.price }]]), pair.canonicalId);
      if (canonical.sku !== pair.sku || canonical.price !== pair.price || canonical.visible !== true || !after.ok) {
        throw new Error(`CANONICAL_READBACK_FAILED:${pair.canonicalId}`);
      }
      results.push({ itemId: pair.staleId, outcome: "deleted_and_readback_verified" });
    }

    for (const pair of VISIBLE_NONCANONICAL_HIDES) {
      const raw = await getBaseItemDetail(pair.staleId);
      const title = typeof raw.title === "string" ? raw.title : "";
      const detail = typeof raw.detail === "string" ? raw.detail : null;
      const stock = Number(raw.stock);
      const current = asItem(raw);
      const canonical = await readDetail(pair.canonicalId);
      if (canonical === "absent" || detail === null || !title || !Number.isFinite(stock) || stock < 0) {
        throw new Error(`HIDE_PRECHECK_FAILED:${pair.staleId}`);
      }
      const decision = assessVisibleHide(pair, new Map([[current.itemId, current], [canonical.itemId, canonical]]), listingFor(pair.sku)?.externalId ?? null);
      if (!decision.ok) throw new Error(`HIDE_PRECHECK_FAILED:${pair.staleId}:${decision.reason}`);
      await editBaseItem({ itemId: pair.staleId, title, detail, price: pair.price, stock, visible: false });
      const hidden = await readDetail(pair.staleId);
      const canonicalAfter = await readDetail(pair.canonicalId);
      if (hidden === "absent" || hidden.visible !== false || hidden.sku !== pair.sku || hidden.price !== pair.price) {
        throw new Error(`HIDE_READBACK_FAILED:${pair.staleId}`);
      }
      if (canonicalAfter === "absent" || canonicalAfter.visible !== pair.canonicalVisible || canonicalAfter.sku !== pair.sku || canonicalAfter.price !== pair.price) {
        throw new Error(`CANONICAL_READBACK_FAILED:${pair.canonicalId}`);
      }
      results.push({ itemId: pair.staleId, outcome: "hidden_and_readback_verified" });
    }

    return NextResponse.json({
      ok: true,
      readOnly: false,
      results,
      errorItems: errors,
      message: "Hidden duplicates were deleted and visible non-canonical items were hidden. Error rows were left unchanged.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({
      ok: false,
      error: message.slice(0, 180),
      warning: "The operation may have partially completed. Re-run the dry run before retrying.",
    }, { status: 409 });
  }
}
