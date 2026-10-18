import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Read-only verification targets from the 2026-10-18 BASE reconciliation.
// This endpoint never edits, deletes, publishes, or remaps BASE/DB records.
const TARGETS = [
  { oldId: "163159140", currentId: "163241527" },
  { oldId: "163179909", currentId: "163340272" },
  { oldId: "163179913", currentId: "163354374" },
  { oldId: "163179920", currentId: "163133044" },
  { oldId: "163179921", currentId: "163354380" },
  { oldId: "163179923", currentId: "163244457" },
  { oldId: "163196446", currentId: "163275407" },
  { oldId: "163196454", currentId: "163120687" },
  { oldId: "163196460", currentId: "163120742" },
  { oldId: "163196468", currentId: "163120689" },
  { oldId: "163197179", currentId: "163242570" },
  { oldId: "163197182", currentId: "163244459" },
  { oldId: "163197185", currentId: "163354375" },
  { oldId: "163197189", currentId: "163292879" },
  { oldId: "163197190", currentId: "163354378" },
] as const;

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "BASE_ITEM_DETAIL_FAILED";
  const match = message.match(/^([A-Z0-9_]+)(?::HTTP_(\d{3}))?/);
  return { code: match?.[1] ?? "BASE_ITEM_DETAIL_FAILED", httpStatus: match?.[2] ? Number(match[2]) : null };
}

function summarize(item: Record<string, unknown>) {
  const visible = item.visible;
  return {
    itemId: String(item.item_id ?? item.id ?? ""),
    title: typeof item.title === "string" ? item.title : null,
    sku: typeof item.identifier === "string" ? item.identifier : null,
    visible: visible === true || visible === 1 || visible === "1"
      ? true
      : visible === false || visible === 0 || visible === "0" ? false : null,
    price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
  };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, readOnly: true, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }

  const results = await Promise.all(TARGETS.map(async ({ oldId, currentId }) => {
    const [oldResult, currentResult] = await Promise.allSettled([
      getBaseItemDetail(oldId),
      getBaseItemDetail(currentId),
    ]);
    return {
      oldId,
      currentId,
      oldItem: oldResult.status === "fulfilled" ? summarize(oldResult.value) : null,
      oldError: oldResult.status === "rejected" ? safeError(oldResult.reason) : null,
      currentItem: currentResult.status === "fulfilled" ? summarize(currentResult.value) : null,
      currentError: currentResult.status === "rejected" ? safeError(currentResult.reason) : null,
    };
  }));

  const summary = {
    ok: results.every((row) => row.oldItem !== null && row.currentItem !== null),
    readOnly: true,
    generatedAt: new Date().toISOString(),
    pairsChecked: results.length,
    itemDetailsAttempted: results.length * 2,
    oldFound: results.filter((row) => row.oldItem !== null).length,
    oldNotFound404: results.filter((row) => row.oldError?.httpStatus === 404).length,
    currentFound: results.filter((row) => row.currentItem !== null).length,
    errors: results.filter((row) => row.oldError !== null || row.currentError !== null).length,
    results,
  };
  return NextResponse.json(summary, {
    status: 200,
    headers: { "Cache-Control": "no-store, private" },
  });
}
