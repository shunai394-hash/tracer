import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";
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
      variantId: String(row.variant_id),
      externalProductId: row.external_product_id == null ? null : String(row.external_product_id),
      externalVariantId: row.external_variant_id == null ? null : String(row.external_variant_id),
      externalSku: row.external_sku == null ? null : String(row.external_sku),
      sellingPrice: row.selling_price == null ? null : Number(row.selling_price),
      status: row.status == null ? null : String(row.status),
    })));
    if (rows.length < 1000) return listings;
  }
  throw new Error("BASE_RECONCILIATION_DB_LISTINGS_SCAN_INCOMPLETE");
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
