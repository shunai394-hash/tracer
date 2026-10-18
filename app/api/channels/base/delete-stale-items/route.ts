import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  deleteAllowlistedStaleBaseItem,
  fetchBaseItemsSnapshot,
  isBaseConfigured,
  BASE_ITEMS_MAX_PAGES,
} from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONFIRMATION = "DELETE_THREE_STALE_BASE_ITEMS";
const TARGETS = [
  { staleId: "163159366", canonicalId: "163355942", sku: "TRC-C9916FE0297A41ACADD8E19B" },
  { staleId: "163159368", canonicalId: "163355946", sku: "TRC-45370D7789BC4D34984EA727" },
  { staleId: "163159369", canonicalId: "163355950", sku: "TRC-19C334F2FD194CD3AB99F389" },
] as const;
const EXPECTED_PRICE = 15856;

type BaseItem = Record<string, unknown>;

function itemId(item: BaseItem | undefined): string {
  return String(item?.item_id ?? "").trim();
}

function visible(item: BaseItem | undefined): boolean | null {
  const value = item?.visible;
  if (value === 1 || value === "1" || value === true) return true;
  if (value === 0 || value === "0" || value === false) return false;
  return null;
}

function price(item: BaseItem | undefined): number | null {
  const value = Number(item?.price);
  return Number.isFinite(value) ? value : null;
}

function validatePair(items: BaseItem[], target: (typeof TARGETS)[number]) {
  const stale = items.find((item) => itemId(item) === target.staleId);
  const canonical = items.find((item) => itemId(item) === target.canonicalId);
  if (!canonical) throw new Error(`CANONICAL_ITEM_MISSING:${target.canonicalId}`);
  if (String(canonical.identifier ?? "").trim() !== target.sku) {
    throw new Error(`CANONICAL_SKU_MISMATCH:${target.canonicalId}`);
  }
  if (price(canonical) !== EXPECTED_PRICE || visible(canonical) !== true) {
    throw new Error(`CANONICAL_PRICE_OR_VISIBILITY_MISMATCH:${target.canonicalId}`);
  }
  if (stale) {
    if (String(stale.identifier ?? "").trim() !== target.sku) {
      throw new Error(`STALE_SKU_MISMATCH:${target.staleId}`);
    }
    if (price(stale) !== EXPECTED_PRICE || visible(stale) !== false) {
      throw new Error(`STALE_PRICE_OR_VISIBILITY_MISMATCH:${target.staleId}`);
    }
  }
  return { stalePresent: Boolean(stale), canonicalPresent: true };
}

async function snapshot() {
  const result = await fetchBaseItemsSnapshot({
    itemPageLimit: 100,
    itemMaxPages: BASE_ITEMS_MAX_PAGES,
  });
  if (!result.complete) throw new Error("BASE_SNAPSHOT_INCOMPLETE");
  return result.items;
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  let body: { apply?: unknown; confirmation?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  if (apply && body.confirmation !== CONFIRMATION) {
    return NextResponse.json({ ok: false, error: "explicit_confirmation_required" }, { status: 400 });
  }

  try {
    const initialItems = await snapshot();
    const plan = TARGETS.map((target) => ({
      ...target,
      ...validatePair(initialItems, target),
    }));

    if (!apply) {
      return NextResponse.json({
        ok: true,
        readOnly: true,
        snapshotComplete: true,
        itemCount: initialItems.length,
        expectedPrice: EXPECTED_PRICE,
        plan,
        message: "Dry run only. No BASE items were deleted.",
      });
    }

    const results: Array<{ staleId: string; outcome: string }> = [];
    for (const target of TARGETS) {
      // Refresh the complete catalog immediately before each destructive request.
      const beforeItems = await snapshot();
      const before = validatePair(beforeItems, target);
      if (!before.stalePresent) {
        results.push({ staleId: target.staleId, outcome: "already_absent_verified" });
        continue;
      }

      await deleteAllowlistedStaleBaseItem(target.staleId);

      // Never trust the delete response alone: read the full catalog back.
      const afterItems = await snapshot();
      if (afterItems.some((item) => itemId(item) === target.staleId)) {
        throw new Error(`DELETE_READBACK_STALE_ITEM_STILL_PRESENT:${target.staleId}`);
      }
      const canonical = afterItems.find((item) => itemId(item) === target.canonicalId);
      if (
        !canonical ||
        String(canonical.identifier ?? "").trim() !== target.sku ||
        price(canonical) !== EXPECTED_PRICE ||
        visible(canonical) !== true
      ) {
        throw new Error(`CANONICAL_READBACK_FAILED:${target.canonicalId}`);
      }
      results.push({ staleId: target.staleId, outcome: "deleted_and_readback_verified" });
    }

    return NextResponse.json({
      ok: true,
      readOnly: false,
      snapshotComplete: true,
      expectedPrice: EXPECTED_PRICE,
      results,
      message: "Every delete was followed by a complete BASE snapshot readback.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({
      ok: false,
      error: message.slice(0, 180),
      warning: "The operation may have partially completed. Re-run dry-run and reconcile each allowlisted ID before retrying.",
    }, { status: 409 });
  }
}
