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
  classifyBaseDetailReadFailure,
  ERROR_HIDDEN_LEAVE,
  HIDDEN_DUPLICATE_DELETES,
  VISIBLE_ERROR_HIDES,
  VISIBLE_NONCANONICAL_HIDES,
  assessErrorHidden,
  assessHiddenDelete,
  assessVisibleErrorHide,
  assessVisibleHide,
  type PublicationRepairItem,
} from "@/lib/channels/base-publication-repair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONFIRMATION = "REPAIR_TWO_REQUESTED_BASE_DUPLICATES";
const ALLOWED_DELETE_IDS = HIDDEN_DUPLICATE_DELETES.map((pair) => pair.staleId);

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
    if (classifyBaseDetailReadFailure(message) === "absent") return "absent";
    throw new Error("BASE_ITEM_DETAIL_READ_INDETERMINATE");
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
  const body = await request.json().catch(() => ({})) as { apply?: unknown; confirmation?: unknown; staleIds?: unknown };
  const apply = body.apply === true;
  const scoped = body.staleIds !== undefined;
  if (scoped && (!Array.isArray(body.staleIds) || body.staleIds.length === 0 ||
      body.staleIds.some((id) => typeof id !== "string" || !ALLOWED_DELETE_IDS.includes(id)) ||
      new Set(body.staleIds).size !== body.staleIds.length)) {
    return NextResponse.json({ ok: false, error: "invalid_stale_ids" }, { status: 400 });
  }
  const requestedDeletes = scoped ? HIDDEN_DUPLICATE_DELETES.filter((pair) => (body.staleIds as string[]).includes(pair.staleId)) : HIDDEN_DUPLICATE_DELETES;
  const requestedHides = scoped ? [] : VISIBLE_NONCANONICAL_HIDES;
  const requestedErrorHides = scoped ? [] : VISIBLE_ERROR_HIDES;
  const requestedErrors = scoped ? [] : ERROR_HIDDEN_LEAVE;
  const actionIds = [...requestedDeletes.map((pair) => pair.staleId), ...requestedHides.map((pair) => pair.staleId), ...requestedErrorHides.map((item) => item.itemId)];
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
    const skus = [...requestedDeletes.map((pair) => pair.sku), ...requestedHides.map((pair) => pair.sku), ...requestedErrorHides.map((item) => item.sku), ...requestedErrors.map((item) => item.sku)];
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

    const deletes = requestedDeletes.map((pair) => ({
      ...pair,
      action: "delete_hidden_duplicate" as const,
      ...assessHiddenDelete(pair, items, listingFor(pair.sku)?.externalId ?? null),
    }));
    const errorHides = requestedErrorHides.map((target) => ({
      ...target,
      action: "hide_visible_error_listing" as const,
      ...assessVisibleErrorHide(target, items, listingFor(target.sku)),
    }));
    const hides = requestedHides.map((pair) => ({
      ...pair,
      action: "hide_visible_noncanonical" as const,
      ...assessVisibleHide(pair, items, listingFor(pair.sku)?.externalId ?? null),
    }));
    const errors = requestedErrors.map((target) => ({
      ...target,
      action: "leave_db_error_base_already_hidden" as const,
      ...assessErrorHidden(target, items, listingFor(target.sku)),
    }));
    const orders = await orderReferences(actionIds);
    const { data: linked, error: linkError } = await db.from("channel_listings")
      .select("external_product_id")
      .eq("channel", "base")
      .in("external_product_id", actionIds);
    if (linkError) throw new Error("PUBLICATION_REPAIR_STALE_LINK_CHECK_FAILED");
    const listingReferences = (linked ?? []).map((row) => String(row.external_product_id));
    const observed = (id: string) => {
      const item = items.get(id);
      return item ? { visible: item.visible, price: item.price, sku: item.sku } : null;
    };
    const withObserved = <T extends { staleId?: string; itemId?: string; canonicalId?: string }>(row: T) => ({
      ...row,
      observed: observed(row.staleId ?? row.itemId ?? ""),
      canonicalObserved: row.canonicalId ? observed(row.canonicalId) : undefined,
    });
    const blocked = deletes.some((row) => !row.ok) || hides.some((row) => !row.ok) || errorHides.some((row) => !row.ok) || errors.some((row) => !row.ok)
      || orders.complete !== true || orders.matches.length > 0 || listingReferences.length > 0;
    const readyDeletes = deletes.filter((row) => row.ok);
    const readyHides = hides.filter((row) => row.ok);
    const readyErrorHides = errorHides.filter((row) => row.ok);

    if (!apply || blocked) {
      return NextResponse.json({
        ok: !blocked,
        readOnly: true,
        snapshotComplete: true,
        itemCount: snapshot.items.length,
        deletes: deletes.map(withObserved),
        hides: hides.map(withObserved),
        errorHides: errorHides.map(withObserved),
        errorItems: errors.map(withObserved),
        orderScan: orders,
        listingReferences,
        blocked,
        message: blocked
          ? "Repair refused. A target no longer matches the verified pair, or an order or listing still references it."
          : "Dry run only. No BASE item was deleted or hidden.",
      }, { status: blocked ? 409 : 200 });
    }

    const results: Array<{ itemId: string; outcome: string }> = [];
    for (const pair of requestedDeletes.filter((candidate) => readyDeletes.some((row) => row.staleId === candidate.staleId))) {
      const staleDetail = await readDetail(pair.staleId);
      const canonicalDetail = await readDetail(pair.canonicalId);
      if (canonicalDetail === "absent") throw new Error(`CANONICAL_READBACK_FAILED:${pair.canonicalId}`);
      if (staleDetail === "absent") {
        // The complete preflight snapshot contained this item. A later 404 conflicts
        // with that evidence, so stop rather than interpreting the discrepancy as success.
        throw new Error(`STALE_DETAIL_CONFLICT_WITH_SNAPSHOT:${pair.staleId}`);
      }
      const before = new Map<string, PublicationRepairItem>([
        [staleDetail.itemId, staleDetail],
        [canonicalDetail.itemId, canonicalDetail],
      ]);
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

    for (const pair of requestedHides.filter((candidate) => readyHides.some((row) => row.staleId === candidate.staleId))) {
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

    for (const target of requestedErrorHides.filter((candidate) => readyErrorHides.some((row) => row.itemId === candidate.itemId))) {
      const raw = await getBaseItemDetail(target.itemId);
      const title = typeof raw.title === "string" ? raw.title : "";
      const detail = typeof raw.detail === "string" ? raw.detail : null;
      const stock = Number(raw.stock);
      const current = asItem(raw);
      if (detail === null || !title || !Number.isFinite(stock) || stock < 0) throw new Error(`HIDE_PRECHECK_FAILED:${target.itemId}`);
      const decision = assessVisibleErrorHide(target, new Map([[current.itemId, current]]), listingFor(target.sku));
      if (!decision.ok) throw new Error(`HIDE_PRECHECK_FAILED:${target.itemId}:${decision.reason}`);
      await editBaseItem({ itemId: target.itemId, title, detail, price: target.price, stock, visible: false });
      const hidden = await readDetail(target.itemId);
      if (hidden === "absent" || hidden.visible !== false || hidden.sku !== target.sku || hidden.price !== target.price) {
        throw new Error(`HIDE_READBACK_FAILED:${target.itemId}`);
      }
      results.push({ itemId: target.itemId, outcome: "error_listing_hidden_and_readback_verified" });
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
