import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getPublishableSupplierListingStatuses } from "@/lib/catalog/canonical-supplier-identity";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { BASE_AUTH_REAUTH_REQUIRED, isBaseAuthenticationFailure } from "@/lib/channels/base-auth-failure";
import { BASE_ITEMS_MAX_PAGES, editBaseItem, getBaseItemDetail, fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Reconciles only listings without a verified canonical supplier identity. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("shop_listings")
    .select("id,product_id,supplier_listing_id,supplier_product_id,supplier_variant_id,published,orderable,tracking_available,pipeline_reason,shopify_product_id,shopify_sync_status,shopify_sync_error,base_item_id,base_publication_status,base_last_error")
    .or("published.eq.true,and(shopify_product_id.not.is.null,shopify_sync_status.is.null),and(shopify_product_id.not.is.null,shopify_sync_status.neq.blocked,shopify_sync_status.neq.synced),and(shopify_product_id.not.is.null,shopify_sync_status.eq.blocked,shopify_sync_error.is.null),and(shopify_product_id.not.is.null,shopify_sync_status.eq.blocked,shopify_sync_error.neq.shopify_unpublished_verified),and(base_item_id.not.is.null,base_last_error.is.null),and(base_item_id.not.is.null,base_last_error.neq.supplier_identity_unlinked_hidden,base_last_error.neq.tracer_unpublished_hidden,base_last_error.neq.base_auth_invalid_reauthorization_required)")
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) return NextResponse.json({ ok: false, stage: "read", error: error.message }, { status: 500 });

  const supplierStatuses = await getPublishableSupplierListingStatuses((data ?? []).map((row) => ({
    listingId: String(row.id),
    supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
    productId: row.product_id == null ? null : String(row.product_id),
    supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
    supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
  })));
  // Repair stale denormalized flags only when the supplier helper has freshly verified the exact native CJ variant.
  const nativeCjRepairIds = (data ?? []).filter((row) => row.supplier_listing_id && supplierStatuses.get(String(row.id)) === "native_cj_verified" && (row.orderable !== true || row.tracking_available !== true)).map((row) => String(row.id));
  if (nativeCjRepairIds.length > 0) {
    const now = new Date().toISOString();
    const { error: repairError } = await db.from("shop_listings").update({ orderable: true, tracking_available: true, pipeline_stage: "SUPPLIER_REVERIFIED", pipeline_status: "pending", pipeline_reason: "native_cj_supplier_variant_verified", pipeline_error: null, pipeline_updated_at: now, updated_at: now }).in("id", nativeCjRepairIds);
    if (repairError) return NextResponse.json({ ok: false, stage: "native_cj_repair", error: repairError.message }, { status: 500 });
  }
  const unlinked = (data ?? []).filter((row) => {
    if (!row.supplier_listing_id) return true;
    const status = supplierStatuses.get(String(row.supplier_listing_id));
    if (!status) return true;
    if (status === "native_cj_verified") return false;
    return row.orderable !== true || row.tracking_available !== true;
  });
  const needsBlock = unlinked.filter((row) => row.published === true || row.orderable !== false || row.pipeline_reason !== "supplier_identity_unlinked");
  if (needsBlock.length > 0) {
    const now = new Date().toISOString();
    const { error: updateError } = await db.from("shop_listings").update({
      published: false,
      orderable: false,
      published_at: null,
      pipeline_stage: "BLOCKED",
      pipeline_status: "blocked",
      pipeline_reason: "supplier_identity_unlinked",
      pipeline_updated_at: now,
      updated_at: now,
    }).in("id", needsBlock.map((row) => row.id));
    if (updateError) return NextResponse.json({ ok: false, stage: "block", error: updateError.message }, { status: 500 });
  }

  const shopifyPending = unlinked.filter((row) => row.shopify_product_id && (row.shopify_sync_status !== "blocked" || row.shopify_sync_error !== "shopify_unpublished_verified")).slice(0, 15);
  const basePending = unlinked.filter((row) => row.base_item_id && row.base_last_error !== "supplier_identity_unlinked_hidden" && row.base_last_error !== BASE_AUTH_REAUTH_REQUIRED).slice(0, 50);
  let shopify: unknown = { skipped: true };
  let base: unknown = { skipped: true };
  const errors: string[] = [];
  let baseAuthReauthorizationRequired = false;
  if (shopifyPending.length > 0) {
    try {
      shopify = await syncPublishedListingsToShopify(15, shopifyPending.map((row) => String(row.id)));
      const result = shopify as { failed?: number; errors?: Array<{ listingId: string; error: string }> };
      if ((result.failed ?? 0) > 0) errors.push(`shopify_unpublish_failed:${JSON.stringify(result.errors?.slice(0, 5) ?? [])}`);
    } catch (cause) { errors.push(`shopify:${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (basePending.length > 0) {
    try {
      base = await publishPublishedListingsToBase(50, basePending.map((row) => String(row.id)));
      const result = base as { attempted?: number; failed?: number; results?: Array<{ listingId: string; ok: boolean; error?: string }> };
      if ((result.attempted ?? 0) === 0 && (result.results?.length ?? 0) === 0) errors.push("base_unpublish_not_attempted:credentials_not_configured_or_no_result");
      if ((result.failed ?? 0) > 0) errors.push(`base_unpublish_failed:${JSON.stringify(result.results?.filter((item) => !item.ok).slice(0, 5) ?? [])}`);

      // Invalid credentials are account-wide. Pause retries for this batch until the token is repaired.
      const authRejected = (result.results ?? []).some((item) => !item.ok && isBaseAuthenticationFailure(item.error));
      if (authRejected) {
        baseAuthReauthorizationRequired = true;
        // BASE credentials are account-wide. Mark every currently discovered
        // unlinked listing with a BASE item, not only this 50-item batch, so
        // later cron runs do not keep retrying the same invalid token.
        const authBlockedIds = unlinked
          .filter((row) => row.base_item_id && row.base_last_error !== "supplier_identity_unlinked_hidden" && row.base_last_error !== "tracer_unpublished_hidden")
          .map((row) => String(row.id));
        const { error: markerError } = await db.from("shop_listings").update({
          base_last_error: BASE_AUTH_REAUTH_REQUIRED,
          base_publication_status: "failed",
          updated_at: new Date().toISOString(),
        }).in("id", authBlockedIds);
        if (markerError) errors.push(`base_auth_circuit_marker_failed:${markerError.message}`);
        errors.push("base_auth_invalid_reauthorization_required: scheduled BASE retries paused for this batch; repair credentials and clear the marker before retrying");
      }
    } catch (cause) { errors.push(`base:${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  // BASE also contains legacy items that have no exact TRACER base_item_id mapping.
  // Use a complete BASE snapshot and the stable TRC-<listing UUID> identifier to
  // keep only currently publishable TRACER listings. Hide (never delete) a small
  // bounded batch of visible orphans on each run.
  const baseOrphans: { snapshotComplete: boolean; visibleChecked: number; attempted: number; hidden: number; failed: number; remainingEstimate: number; skipped?: string } = {
    snapshotComplete: false, visibleChecked: 0, attempted: 0, hidden: 0, failed: 0, remainingEstimate: 0,
  };
  if (!isBaseConfigured()) {
    baseOrphans.skipped = "base_oauth_not_configured";
  } else {
    try {
      const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
      if (!snapshot.complete) throw new Error("BASE_ITEMS_SNAPSHOT_INCOMPLETE");
      baseOrphans.snapshotComplete = true;

      const allListings: Array<{
        id: string;
        product_id: string | null;
        supplier_listing_id: string | null;
        supplier_product_id: string | null;
        supplier_variant_id: string | null;
        orderable: boolean | null;
        tracking_available: boolean | null;
        base_item_id: string | number | null;
      }> = [];
      for (let offset = 0; offset < 10_000; offset += 1000) {
        const { data: page, error: pageError } = await db
          .from("shop_listings")
          .select("id,product_id,published,supplier_listing_id,supplier_product_id,supplier_variant_id,orderable,tracking_available,base_item_id")
          .order("created_at", { ascending: true })
          .range(offset, offset + 999);
        if (pageError) throw new Error("TRACER_LISTING_SNAPSHOT_READ_FAILED");
        allListings.push(...((page ?? []) as typeof allListings));
        if ((page ?? []).length < 1000) break;
        if (offset === 9000) throw new Error("TRACER_LISTING_SNAPSHOT_INCOMPLETE");
      }
      const statuses = await getPublishableSupplierListingStatuses(allListings.map((row) => ({
        listingId: String(row.id),
        supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
        productId: row.product_id == null ? null : String(row.product_id),
        supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
        supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
      })));
      const eligibleIdentifiers = new Set(allListings
        .filter((row) => row.published === true && row.orderable === true && row.tracking_available === true
          && row.supplier_listing_id && statuses.has(String(row.id)))
        .map((row) => `TRC-${String(row.id).toLowerCase()}`));
      const knownBaseIds = new Set(allListings
        .map((row) => String(row.base_item_id ?? "").trim())
        .filter(Boolean));
      const visibleOrphans = snapshot.items.filter((item) => {
        const visible = item.visible === true || item.visible === 1 || item.visible === "1";
        const itemId = String(item.item_id ?? "").trim();
        const identifier = String(item.identifier ?? "").trim().toLowerCase();
        return visible && itemId && !knownBaseIds.has(itemId) && !eligibleIdentifiers.has(identifier);
      });
      baseOrphans.visibleChecked = snapshot.items.filter((item) =>
        item.visible === true || item.visible === 1 || item.visible === "1"
      ).length;
      baseOrphans.remainingEstimate = visibleOrphans.length;
      for (const item of visibleOrphans.slice(0, 15)) {
        const itemId = String(item.item_id ?? "").trim();
        const price = Number(item.price);
        if (!itemId || !Number.isFinite(price) || price <= 0) {
          baseOrphans.failed += 1;
          errors.push(`base_orphan_missing_required_fields:${itemId || "unknown"}`);
          continue;
        }
        baseOrphans.attempted += 1;
        try {
          await editBaseItem({
            itemId,
            title: String(item.title ?? item.name ?? "商品情報確認中"),
            detail: String(item.detail ?? item.description ?? ""),
            price,
            stock: 0,
            visible: false,
          });
          baseOrphans.hidden += 1;
        } catch (cause) {
          baseOrphans.failed += 1;
          const message = cause instanceof Error ? cause.message : String(cause);
          errors.push(`base_orphan_hide_failed:${itemId}:${message}`);
          if (isBaseAuthenticationFailure(message)) {
            baseAuthReauthorizationRequired = true;
            break;
          }
        }
      }
      baseOrphans.remainingEstimate = Math.max(0, visibleOrphans.length - baseOrphans.hidden);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      baseOrphans.skipped = message;
      errors.push(`base_orphan_reconciliation_failed:${message}`);
    }
  }

  // Directly reconcile BASE channel_listings that have a known supplier-fulfillment
  // failure but no matching shop_listings row. Hide them on BASE and verify the
  // result through the BASE item-detail API; never delete historical records.
  const baseUnfulfillable = {
    candidates: 0,
    attempted: 0,
    hiddenVerified: 0,
    failed: 0,
    skipped: 0,
    results: [] as Array<{ itemId: string; ok: boolean; reason?: string }>,
  };
  if (isBaseConfigured()) {
    const { data: failedBaseRows, error: failedBaseReadError } = await db
      .from("channel_listings")
      .select("external_product_id,external_sku,status,last_error")
      .eq("channel", "base")
      .eq("status", "error")
      .like("last_error", "supplier_offer_not_fulfillable%")
      .limit(100);
    if (failedBaseReadError) {
      errors.push(`base_unfulfillable_read_failed:${failedBaseReadError.message}`);
    } else {
      baseUnfulfillable.candidates = (failedBaseRows ?? []).length;
      for (const row of (failedBaseRows ?? []).slice(0, 15)) {
        const itemId = String(row.external_product_id ?? "").trim();
        if (!/^\d+$/.test(itemId)) {
          baseUnfulfillable.failed += 1;
          baseUnfulfillable.results.push({ itemId: itemId || "unknown", ok: false, reason: "invalid_base_item_id" });
          continue;
        }
        baseUnfulfillable.attempted += 1;
        try {
          const current = await getBaseItemDetail(itemId);
          const title = String(current.title ?? current.name ?? "").trim();
          const detail = String(current.detail ?? current.description ?? "").trim();
          const price = Number(current.price);
          if (!title || !Number.isFinite(price) || price <= 0) {
            throw new Error("base_item_detail_missing_title_or_price");
          }
          await editBaseItem({ itemId, title, detail, price, stock: 0, visible: false });
          const verified = await getBaseItemDetail(itemId);
          const visibleValue = verified.visible;
          const hiddenVerified = visibleValue === false || visibleValue === 0 || visibleValue === "0";
          if (!hiddenVerified) throw new Error("base_item_visibility_not_confirmed_hidden_after_hide");
          const { error: markError } = await db.from("channel_listings")
            .update({ status: "hidden", last_error: "supplier_offer_not_fulfillable_hidden_verified", last_synced_at: new Date().toISOString() })
            .eq("channel", "base")
            .eq("external_product_id", itemId)
            .like("last_error", "supplier_offer_not_fulfillable%");
          if (markError) throw new Error(`base_hide_verified_but_db_marker_failed:${markError.message}`);
          baseUnfulfillable.hiddenVerified += 1;
          baseUnfulfillable.results.push({ itemId, ok: true });
        } catch (cause) {
          baseUnfulfillable.failed += 1;
          const reason = cause instanceof Error ? cause.message : String(cause);
          baseUnfulfillable.results.push({ itemId, ok: false, reason });
          errors.push(`base_unfulfillable_hide_failed:${itemId}:${reason}`);
          if (isBaseAuthenticationFailure(reason)) {
            baseAuthReauthorizationRequired = true;
            break;
          }
        }
      }
      baseUnfulfillable.skipped = Math.max(0, baseUnfulfillable.candidates - baseUnfulfillable.attempted);
    }
  } else {
    baseUnfulfillable.skipped = 1;
  }

  // Read back the explicitly tracked 15 BASE listings that were previously hidden
  // for unverified supplier identity. This is read-only: report actual visibility
  // and stock from BASE, without changing the item or assuming a prior write worked.
  const targetedBaseReadbackIds = [
    "163179909", "163179921", "163179923", "163196446", "163197189",
    "163197190", "163197185", "163196460", "163196454", "163197179",
    "163196468", "163197182", "163179913", "163179920", "163159140",
  ];
  const targetedBaseReadback: Array<{
    itemId: string; ok: boolean; visible: boolean | null; stock: number | null; reason?: string;
  }> = [];
  if (isBaseConfigured()) {
    for (const itemId of targetedBaseReadbackIds) {
      try {
        const item = await getBaseItemDetail(itemId);
        const visibleValue = item.visible;
        const visible = visibleValue === true || visibleValue === 1 || visibleValue === "1"
          ? true
          : visibleValue === false || visibleValue === 0 || visibleValue === "0" ? false : null;
        const rawStock = Number(item.stock);
        const stock = Number.isFinite(rawStock) ? rawStock : null;
        const ok = visible === false && stock === 0;
        targetedBaseReadback.push({ itemId, ok, visible, stock, ...(ok ? {} : { reason: "visibility_or_stock_not_confirmed" }) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const match = message.match(/^([A-Z0-9_]+?)(?::HTTP_(\\d{3}))?(?::|$)/);
        targetedBaseReadback.push({
          itemId, ok: false, visible: null, stock: null,
          reason: match ? [match[1], match[2] ? `HTTP_${match[2]}` : null].filter(Boolean).join(":") : "BASE_ITEM_DETAIL_FAILED",
        });
      }
    }
  } else {
    for (const itemId of targetedBaseReadbackIds) {
      targetedBaseReadback.push({ itemId, ok: false, visible: null, stock: null, reason: "base_oauth_not_configured" });
    }
  }
  const targetedBaseReadbackSummary = {
    checked: targetedBaseReadback.length,
    confirmedHiddenStockZero: targetedBaseReadback.filter((row) => row.ok).length,
    notConfirmed: targetedBaseReadback.filter((row) => !row.ok).length,
  };
  console.info("[TRACER TARGETED BASE READBACK]", { ...targetedBaseReadbackSummary, results: targetedBaseReadback });

  if (errors.length > 0) {
    console.error("[unpublish-unlinked] external channel reconciliation incomplete", {
      candidatesChecked: (data ?? []).length,
      unlinkedFound: unlinked.length,
      shopifyAttempted: shopifyPending.length,
      baseAttempted: basePending.length,
      baseOrphanAttempted: baseOrphans.attempted,
      baseOrphanHidden: baseOrphans.hidden,
      baseAuthReauthorizationRequired,
      errors,
    });
  }

  const shopifyResult = shopify as { hidden?: number; failed?: number };
  const baseResult = base as { hidden?: number; failed?: number };
  const report = {
    ok: errors.length === 0,
    candidatesChecked: (data ?? []).length,
    unlinkedFound: unlinked.length,
    databaseBlocked: needsBlock.length,
    shopifyAttempted: shopifyPending.length,
    baseAttempted: basePending.length,
    baseOrphans,
    baseUnfulfillable,
    baseAuthReauthorizationRequired,
    shopifyHidden: shopifyResult.hidden ?? null,
    shopifyFailed: shopifyResult.failed ?? null,
    baseHidden: baseResult.hidden ?? null,
    baseFailed: baseResult.failed ?? null,
    errorCount: errors.length,
  };
  console.info("[TRACER UNLINKED RECONCILIATION]", report);
  return NextResponse.json({ ...report, shopify, base, errors }, { status: errors.length === 0 ? 200 : 207 });
}
