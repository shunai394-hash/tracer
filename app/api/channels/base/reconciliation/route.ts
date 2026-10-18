import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { BaseSnapshotInterrupted, fetchBaseItemsSnapshot, isBaseConfigured, type BaseSnapshotCheckpoint } from "@/lib/channels/base";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { reconcileBaseItems, type BaseAuditInsertRow, type BaseChannelListing } from "@/lib/channels/base-actual-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type DbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };

function dbFailure(error: DbError) {
  return {
    code: error.code ?? null,
    message: error.message?.slice(0, 240) ?? null,
    details: error.details?.slice(0, 180) ?? null,
    hint: error.hint?.slice(0, 180) ?? null,
  };
}

async function readBaseListings(db: ReturnType<typeof createSupabaseAdminClient>): Promise<BaseChannelListing[]> {
  const listings: BaseChannelListing[] = [];
  for (let page = 0; page < 20; page += 1) {
    const from = page * 1000;
    const { data, error } = await db
      .from("channel_listings")
      .select("id,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
      .eq("channel", "base")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error("BASE_RECONCILIATION_DB_LISTINGS_READ_FAILED:" + (error.code ?? "unknown"));
    const rows = data ?? [];
    listings.push(...rows.map((row) => ({
      id: String(row.id),
      variantId: row.variant_id == null ? null : String(row.variant_id),
      externalProductId: row.external_product_id == null ? null : String(row.external_product_id),
      externalVariantId: row.external_variant_id == null ? null : String(row.external_variant_id),
      externalSku: row.external_sku == null ? null : String(row.external_sku),
      sellingPrice: row.selling_price == null ? null : Number(row.selling_price),
      status: row.status == null ? null : String(row.status),
    })));
    if (rows.length < 1000) break;
    if (page === 19) throw new Error("BASE_RECONCILIATION_DB_LISTINGS_SCAN_INCOMPLETE");
  }

  // The active BASE publisher still has legacy shop_listings rows. Include them
  // in reconciliation by exact BASE item ID when no commerce-native channel row
  // owns that ID. Never use title or price to create a mapping.
  const existingExternalIds = new Set(
    listings.map((row) => String(row.externalProductId ?? "").trim()).filter(Boolean),
  );
  const legacyRows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    if (from >= 50_000) throw new Error("BASE_RECONCILIATION_LEGACY_SCAN_INCOMPLETE");
    const { data, error } = await db
      .from("shop_listings")
      .select("id,base_item_id,selling_price,published,base_publication_status")
      .not("base_item_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error("BASE_RECONCILIATION_LEGACY_LISTINGS_READ_FAILED:" + (error.code ?? "unknown"));
    legacyRows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if ((data ?? []).length < 1000) break;
  }

  for (const row of legacyRows) {
    const externalId = String(row.base_item_id ?? "").trim();
    if (!externalId || existingExternalIds.has(externalId)) continue;
    listings.push({
      id: "legacy-shop-listing:" + String(row.id),
      variantId: null,
      externalProductId: externalId,
      externalVariantId: null,
      externalSku: null,
      sellingPrice: row.selling_price == null ? null : Number(row.selling_price),
      status: row.base_publication_status == null
        ? row.published === true ? "published" : row.published === false ? "hidden" : null
        : String(row.base_publication_status),
    });
  }
  return listings;
}

async function persistDedicated(
  db: ReturnType<typeof createSupabaseAdminClient>,
  rows: Array<BaseAuditInsertRow & { run_id: string; observed_at: string }>,
) {
  let written = 0;
  let primary: ReturnType<typeof dbFailure> | null = null;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const { error } = await db.from("channel_price_reconciliation_audit").insert(batch);
    if (!error) {
      written += batch.length;
      continue;
    }
    // A privilege or missing-table error repeats for every row. Walking them
    // one by one exceeds the function limit and drops the response.
    primary = dbFailure(error);
    return { written, primary, rest: rows.slice(offset) };
  }
  return { written, primary, rest: [] as typeof rows };
}

async function persistEventFallback(
  db: ReturnType<typeof createSupabaseAdminClient>,
  rows: Array<BaseAuditInsertRow & { run_id: string; observed_at: string }>,
) {
  let written = 0;
  const failedIds: string[] = [];
  let error: ReturnType<typeof dbFailure> | null = null;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100).map((row, index) => {
      const entityId = row.external_product_id ?? `missing:${offset + index}`;
      return {
        event_key: `base-recon:${row.run_id}:${entityId}`,
        event_type: "base_price_reconciliation_audit",
        entity_type: "base_item",
        entity_id: entityId,
        status: String(row.details.mappingStatus ?? "recorded").slice(0, 40),
        detail: row,
      };
    });
    const { error: upsertError } = await db.from("commerce_events").upsert(batch, { onConflict: "event_key" });
    if (!upsertError) {
      written += batch.length;
      continue;
    }
    error ??= dbFailure(upsertError);
    failedIds.push(...rows.slice(offset).map((row, index) => row.external_product_id ?? `missing:${offset + index}`));
    break;
  }
  return { written, failedIds, error };
}

/** Authenticated, read-only BASE API reconciliation. No listing is edited or published. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const headers = { "Cache-Control": "no-store" };
  if (!isBaseConfigured()) {
    return NextResponse.json(
      { ok: false, phase: "base_item_reconciliation", error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
      { status: 503, headers },
    );
  }

  const runId = `base-api-${new Date().toISOString()}-${crypto.randomUUID()}`;
  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 50 });
    if (!snapshot.complete) {
      return NextResponse.json({
        ok: false,
        phase: "base_item_reconciliation",
        runId,
        apiReadComplete: false,
        apiErrors: 1,
        itemCount: snapshot.items.length,
        pages: snapshot.pages,
        error: "BASE_ITEMS_SCAN_INCOMPLETE",
        auditRowsWritten: 0,
        items: [],
      }, { status: 502, headers });
    }

    const db = createSupabaseAdminClient();
    const listings = await readBaseListings(db);
    const reconciled = reconcileBaseItems(snapshot.items, listings);
    const observedAt = new Date().toISOString();
    const auditRows = reconciled.rows.map((row) => ({ ...row, run_id: runId, observed_at: observedAt }));
    const dedicated = await persistDedicated(db, auditRows);
    let written = dedicated.written;
    let storage: "channel_price_reconciliation_audit" | "commerce_events" | "mixed" = "channel_price_reconciliation_audit";
    let fallbackError: ReturnType<typeof dbFailure> | null = null;
    let failedIds: string[] = [];
    if (dedicated.rest.length > 0) {
      const fallback = await persistEventFallback(db, dedicated.rest);
      written += fallback.written;
      failedIds = [...failedIds, ...fallback.failedIds];
      fallbackError = fallback.error;
      storage = dedicated.written > 0 ? "mixed" : "commerce_events";
    }

    const evidenceComplete = snapshot.complete && written === reconciled.items.length && failedIds.length === 0;
    const summary = {
      apiReadComplete: true,
      apiErrors: 0,
      ...reconciled.summary,
    };
    console.info("[TRACER BASE ITEM RECONCILIATION]", {
      runId,
      ...summary,
      auditRowsWritten: written,
      auditStorage: storage,
      auditWriteErrorCode: dedicated.primary?.code ?? null,
    });
    if (dedicated.primary) {
      console.error("[TRACER BASE RECONCILIATION AUDIT WRITE FAILED]", {
        runId,
        ...dedicated.primary,
        fallbackStorage: storage,
        fallbackWritten: written - dedicated.written,
      });
    }
    return NextResponse.json({
      ok: evidenceComplete && summary.unmappedItems === 0 && summary.ambiguousItems === 0
        && summary.unknownVisibility === 0 && summary.unreadablePrices === 0
        && summary.priceMismatches === 0 && summary.skuMismatches === 0
        && summary.publicationMismatches === 0,
      evidenceComplete,
      phase: "base_item_reconciliation",
      runId,
      pages: snapshot.pages,
      auditRowsWritten: written,
      auditStorage: storage,
      auditWriteFailed: dedicated.primary !== null || fallbackError !== null,
      auditWriteErrorCode: dedicated.primary?.code ?? fallbackError?.code ?? null,
      auditWriteError: dedicated.primary?.message ?? fallbackError?.message ?? null,
      auditWriteErrorDetails: dedicated.primary?.details ?? fallbackError?.details ?? null,
      auditFailedItemIds: failedIds,
      ...summary,
      items: reconciled.items,
    }, { status: evidenceComplete ? 200 : 207, headers });
  } catch (error) {
    if (error instanceof BaseSnapshotInterrupted) {
      return NextResponse.json({
        ok: false,
        evidenceComplete: false,
        resumable: true,
        phase: "base_item_reconciliation",
        runId,
        checkpoint: error.checkpoint,
        priorItems: error.items,
        apiReadComplete: false,
        apiErrors: 1,
        itemCount: error.items.length,
        pages: error.checkpoint.pagesFetched,
        error: "BASE_ITEMS_SNAPSHOT_INTERRUPTED",
        auditRowsWritten: 0,
        items: [],
      }, { status: 200, headers });
    }
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    console.error("[TRACER BASE ITEM RECONCILIATION FAILED]", {
      runId,
      stage: message.split(":")[0].slice(0, 100),
      status,
    });
    return NextResponse.json({
      ok: false,
      evidenceComplete: false,
      phase: "base_item_reconciliation",
      runId,
      apiReadComplete: false,
      apiErrors: 1,
      error: message.split(":")[0].slice(0, 100),
      httpStatus: status,
      auditRowsWritten: 0,
      items: [],
    }, { status: 502, headers });
  }
}

/** Continues a snapshot that stopped after a timeout. The caller must return the rows already fetched. */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const headers = { "Cache-Control": "no-store" };
  if (!isBaseConfigured()) {
    return NextResponse.json(
      { ok: false, phase: "base_item_reconciliation", error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
      { status: 503, headers },
    );
  }
  let body: { checkpoint?: BaseSnapshotCheckpoint; priorItems?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400, headers });
  }
  const priorItems = Array.isArray(body.priorItems)
    ? body.priorItems.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const checkpoint = body.checkpoint;
  if (!checkpoint || !Number.isFinite(checkpoint.nextOffset) || !Number.isFinite(checkpoint.pagesFetched) || !Array.isArray(checkpoint.itemIds)) {
    return NextResponse.json({ ok: false, error: "checkpoint_required" }, { status: 400, headers });
  }
  if (priorItems.length !== checkpoint.itemIds.length || priorItems.length > 5000) {
    return NextResponse.json({ ok: false, error: "BASE_ITEMS_SNAPSHOT_CHECKPOINT_MISMATCH" }, { status: 409, headers });
  }
  const runId = `base-api-${new Date().toISOString()}-${crypto.randomUUID()}`;
  try {
    const snapshot = await fetchBaseItemsSnapshot({
      itemPageLimit: 100,
      itemMaxPages: 50,
      checkpoint,
      priorItems,
    });
    if (!snapshot.complete) {
      return NextResponse.json({
        ok: false,
        phase: "base_item_reconciliation",
        runId,
        apiReadComplete: false,
        error: "BASE_ITEMS_SCAN_INCOMPLETE",
        auditRowsWritten: 0,
        items: [],
      }, { status: 502, headers });
    }
    const db = createSupabaseAdminClient();
    const listings = await readBaseListings(db);
    const reconciled = reconcileBaseItems(snapshot.items, listings);
    const observedAt = new Date().toISOString();
    const auditRows = reconciled.rows.map((row) => ({ ...row, run_id: runId, observed_at: observedAt }));
    const dedicated = await persistDedicated(db, auditRows);
    let written = dedicated.written;
    let storage: "channel_price_reconciliation_audit" | "commerce_events" | "mixed" = "channel_price_reconciliation_audit";
    let fallbackError: ReturnType<typeof dbFailure> | null = null;
    let failedIds: string[] = [];
    if (dedicated.rest.length > 0) {
      const fallback = await persistEventFallback(db, dedicated.rest);
      written += fallback.written;
      failedIds = [...failedIds, ...fallback.failedIds];
      fallbackError = fallback.error;
      storage = dedicated.written > 0 ? "mixed" : "commerce_events";
    }
    const evidenceComplete = written === reconciled.items.length && failedIds.length === 0;
    const summary = { apiReadComplete: true, apiErrors: 0, ...reconciled.summary };
    return NextResponse.json({
      ok: evidenceComplete && summary.unmappedItems === 0 && summary.ambiguousItems === 0
        && summary.unknownVisibility === 0 && summary.unreadablePrices === 0
        && summary.priceMismatches === 0 && summary.skuMismatches === 0
        && summary.publicationMismatches === 0,
      evidenceComplete,
      phase: "base_item_reconciliation",
      runId,
      pages: snapshot.pages,
      resumedFromOffset: checkpoint.nextOffset,
      auditRowsWritten: written,
      auditStorage: storage,
      auditWriteFailed: dedicated.primary !== null || fallbackError !== null,
      auditWriteErrorCode: dedicated.primary?.code ?? fallbackError?.code ?? null,
      auditWriteError: dedicated.primary?.message ?? fallbackError?.message ?? null,
      auditWriteErrorDetails: dedicated.primary?.details ?? fallbackError?.details ?? null,
      auditFailedItemIds: failedIds,
      ...summary,
      items: reconciled.items,
    }, { status: evidenceComplete ? 200 : 207, headers });
  } catch (error) {
    if (error instanceof BaseSnapshotInterrupted) {
      return NextResponse.json({
        ok: false,
        evidenceComplete: false,
        resumable: true,
        phase: "base_item_reconciliation",
        runId,
        checkpoint: error.checkpoint,
        priorItems: error.items,
        apiReadComplete: false,
        apiErrors: 1,
        itemCount: error.items.length,
        pages: error.checkpoint.pagesFetched,
        error: "BASE_ITEMS_SNAPSHOT_INTERRUPTED",
        auditRowsWritten: 0,
        items: [],
      }, { status: 200, headers });
    }
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    return NextResponse.json({
      ok: false,
      evidenceComplete: false,
      error: message.split(":")[0].slice(0, 100),
      auditRowsWritten: 0,
      items: [],
    }, { status: 502, headers });
  }
}
