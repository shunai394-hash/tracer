import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TARGETS = [
  { oldId: "163125132", currentId: "163240276", sku: "TRC-2063580BEEED461580958BD2" },
  { oldId: "163125145", currentId: "163240081", sku: "TRC-70DAC828F1984A75BABD539C" },
  { oldId: "163130238", currentId: "163240521", sku: "TRC-6F1BC5912E694CF799BC38BB" },
  { oldId: "163159274", currentId: "163159273", sku: "TRC-015C4A01F2694EBC8A868B57" },
  { oldId: "163159329", currentId: "163159682", sku: "TRC-521C3D01E4B741868E8D1345" },
  { oldId: "163159366", currentId: "163355942", sku: "TRC-C9916FE0297A41ACADD8E19B" },
  { oldId: "163159368", currentId: "163355946", sku: "TRC-45370D7789BC4D34984EA727" },
  { oldId: "163159369", currentId: "163355950", sku: "TRC-19C334F2FD194CD3AB99F389" },
] as const;

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "BASE_ITEM_DETAIL_FAILED";
  const match = message.match(/^([A-Z0-9_]+)(?::HTTP_(\d{3}))?/);
  return {
    code: match?.[1] ?? "BASE_ITEM_DETAIL_FAILED",
    httpStatus: match?.[2] ? Number(match[2]) : null,
  };
}

function itemSummary(item: Record<string, unknown>) {
  return {
    itemId: String(item.item_id ?? item.id ?? ""),
    title: typeof item.title === "string" ? item.title : null,
    sku: typeof item.identifier === "string" ? item.identifier : null,
    visible: item.visible === true || item.visible === 1 || item.visible === "1",
    price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
  };
}

/**
 * Read-only BASE API check of eight legacy IDs and their canonical counterparts.
 * No item is edited, deleted, published, or remapped by this route.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }

  const results = await Promise.all(TARGETS.map(async (target) => {
    const [oldResult, currentResult] = await Promise.allSettled([
      getBaseItemDetail(target.oldId),
      getBaseItemDetail(target.currentId),
    ]);
    const oldItem = oldResult.status === "fulfilled" ? itemSummary(oldResult.value) : null;
    const currentItem = currentResult.status === "fulfilled" ? itemSummary(currentResult.value) : null;
    const oldError = oldResult.status === "rejected" ? safeError(oldResult.reason) : null;
    const currentError = currentResult.status === "rejected" ? safeError(currentResult.reason) : null;

    let classification: "old_id_not_found" | "current_id_migration_candidate" | "indeterminate";
    let reason: string;
    if (oldError?.httpStatus === 404 && currentItem && currentItem.sku === target.sku) {
      classification = "old_id_not_found";
      reason = "old_detail_http_404_and_current_item_sku_matches_audit";
    } else if (oldItem && currentItem && oldItem.sku === target.sku &&
               currentItem.sku === target.sku && oldItem.itemId !== currentItem.itemId) {
      classification = "indeterminate";
      reason = "both_ids_resolve_with_same_sku_possible_duplicate_requires_manual_review";
    } else if (oldError && oldError.httpStatus !== 404) {
      classification = "indeterminate";
      reason = "old_id_read_failed_without_authoritative_not_found";
    } else if (currentError || !currentItem || currentItem.sku !== target.sku) {
      classification = "indeterminate";
      reason = "current_id_unverified_or_sku_mismatch";
    } else if (oldError?.httpStatus === 404) {
      classification = "indeterminate";
      reason = "old_id_404_but_current_item_not_verified";
    } else {
      classification = "indeterminate";
      reason = "response_does_not_prove_safe_migration";
    }

    return {
      oldId: target.oldId,
      expectedCurrentId: target.currentId,
      expectedSku: target.sku,
      classification,
      reason,
      oldItem,
      oldError,
      currentItem,
      currentError,
      currentUrl: `https://tracer.base.ec/items/${target.currentId}`,
    };
  }));

  const summary = {
    ok: results.every((row) => row.classification !== "indeterminate"),
    readOnly: true,
    generatedAt: new Date().toISOString(),
    checked: results.length,
    oldIdNotFound: results.filter((row) => row.classification === "old_id_not_found").length,
    migrationCandidates: results.filter((row) => row.classification === "current_id_migration_candidate").length,
    indeterminate: results.filter((row) => row.classification === "indeterminate").length,
    results,
  };
  return NextResponse.json(summary, {
    status: 200,
    headers: { "Cache-Control": "no-store, private" },
  });
}
