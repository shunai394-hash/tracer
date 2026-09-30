import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";

export const runtime = "nodejs";
export const maxDuration = 300;

type Snapshot = {
  products: number;
  supplierListings: number;
  orderableSuppliers: number;
  shopListings: number;
  publishedListings: number;
  eligibleForBase: number;
  onBase: number;
  basePublished: number;
  orders: number;
};

async function snapshot(db: ReturnType<typeof createSupabaseAdminClient>): Promise<Snapshot> {
  const productsQuery = db.from("products").select("*", { count: "exact", head: true });
  const supplierListingsQuery = db.from("supplier_listings").select("*", { count: "exact", head: true });
  const orderableSuppliersQuery = db.from("supplier_listings").select("*", { count: "exact", head: true }).eq("orderable", true);
  const shopListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true });
  const publishedListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).eq("published", true);
  const eligibleForBaseQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).eq("published", true).eq("orderable", true).gt("inventory", 0).not("image_url", "is", null);
  const onBaseQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null);
  const basePublishedQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null).eq("base_publication_status", "published").eq("published", true);
  const ordersQuery = db.from("shop_orders").select("*", { count: "exact", head: true });

  const [productsResult, supplierListingsResult, orderableSuppliersResult, shopListingsResult, publishedListingsResult, eligibleForBaseResult, onBaseResult, basePublishedResult, ordersResult] = await Promise.all([
    productsQuery, supplierListingsQuery, orderableSuppliersQuery, shopListingsQuery, publishedListingsQuery, eligibleForBaseQuery, onBaseQuery, basePublishedQuery, ordersQuery,
  ]);

  const results = [
    ["products", productsResult], ["supplier_listings", supplierListingsResult], ["supplier_listings(orderable)", orderableSuppliersResult],
    ["shop_listings", shopListingsResult], ["shop_listings(published)", publishedListingsResult], ["shop_listings(eligible)", eligibleForBaseResult],
    ["shop_listings(on_base)", onBaseResult], ["shop_listings(base_published)", basePublishedResult], ["shop_orders", ordersResult],
  ] as const;

  for (const [label, result] of results) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  return {
    products: productsResult.count ?? 0, supplierListings: supplierListingsResult.count ?? 0, orderableSuppliers: orderableSuppliersResult.count ?? 0,
    shopListings: shopListingsResult.count ?? 0, publishedListings: publishedListingsResult.count ?? 0, eligibleForBase: eligibleForBaseResult.count ?? 0,
    onBase: onBaseResult.count ?? 0, basePublished: basePublishedResult.count ?? 0, orders: ordersResult.count ?? 0,
  };
}

function decide(before: Snapshot) {
  if (before.eligibleForBase > before.basePublished) return "publish_base";
  if (before.publishedListings === 0) return "discover_supply";
  if (before.orderableSuppliers === 0) return "discover_supply";
  return "recheck_pipeline";
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  let cronId: string | null = null;

  try {
    const { data: run, error: runError } = await db.from("cron_runs").insert({
      job_name: "patrol-ai",
      status: "running",
      metadata: { actor: "patrol-ai", phase: "starting" },
    }).select("id").single();

    if (runError) {
      console.error("[TRACER PATROL AI] could not create run record", runError.message);
    } else {
      cronId = String(run.id);
    }

    const before = await snapshot(db);
    const decision = decide(before);
    const actions: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    if (decision === "discover_supply") {
      try {
        const result = await discoverAndCreateCjSupply(5, {
          deadlineAt: startedAt + 150_000,
        });
        actions.push({
          action: "discover_supply",
          attempted: result.items?.length ?? 0,
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        actions.push({ action: "discover_supply", ok: false, error: message });
      }
    }

    // Always run BASE reconciliation after discovery or when eligible supply
    // already exists. This is the actual repair step that turns verified supply
    // into a public listing.
    try {
      const base = await publishPublishedListingsToBase(10);
      actions.push({
        action: "publish_base",
        attempted: base.attempted,
        published: base.published,
        skipped: base.skipped,
        failed: base.failed,
        results: base.results,
      });
      for (const item of base.results) {
        if (!item.ok && !item.skipped && item.error) errors.push(String(item.error));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      actions.push({ action: "publish_base", ok: false, error: message });
    }

    const after = await snapshot(db);
    const progress = {
      newPublishedListings: after.publishedListings - before.publishedListings,
      newBaseItems: after.basePublished - before.basePublished,
      newOrders: after.orders - before.orders,
    };

    const status = errors.length > 0
      ? (after.basePublished > before.basePublished || after.publishedListings > before.publishedListings ? "partial" : "failed")
      : "succeeded";

    const report = {
      ok: errors.length === 0,
      status,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      decision,
      before,
      after,
      progress,
      actions,
      errors,
      message: errors.length
        ? "巡回AIが異常を検知し、修復を実行したが未解決項目が残っています。"
        : progress.newBaseItems > 0 || progress.newPublishedListings > 0
          ? "巡回AIが異常を検知し、自動修復して進捗を確認しました。"
          : "巡回AIは実行済みですが、今回の巡回では公開可能な新規商品を確認できませんでした。",
    };

    console.log("[TRACER PATROL AI REPORT]", JSON.stringify(report));

    if (cronId) {
      await db.from("cron_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: after.publishedListings,
        failed: errors.length,
        status,
        error: errors.length ? errors.join("; ") : null,
        metadata: report,
      }).eq("id", cronId);
    }

    return NextResponse.json(report, { status: errors.length && status === "failed" ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER PATROL AI FATAL]", message);
    if (cronId) {
      await db.from("cron_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: "failed",
        error: message,
        metadata: { actor: "patrol-ai", fatal: true },
      }).eq("id", cronId);
    }
    return NextResponse.json({ ok: false, status: "failed", error: message }, { status: 500 });
  }
}
