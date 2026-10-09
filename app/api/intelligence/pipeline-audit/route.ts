import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Filter = (query: ReturnType<ReturnType<Db["from"]>["select"]>) => ReturnType<ReturnType<Db["from"]>["select"]>;

async function count(db: Db, table: string, filter?: Filter): Promise<number | string> {
  const base = db.from(table).select("*", { count: "exact", head: true });
  const { count: value, error } = await (filter ? filter(base) : base);
  return error ? `error: ${error.message}` : value ?? 0;
}

/**
 * Read-only funnel counts for the autonomous commerce pipeline, so every
 * patrol run records measured Before/After numbers instead of assumptions.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  const entries = {
    products: count(db, "products"),
    supplier_listings: count(db, "supplier_listings"),
    supplier_listings_orderable: count(db, "supplier_listings", (q) => q.eq("orderable", true)),
    supplier_listings_unconfigured_placeholders: count(db, "supplier_listings", (q) => q.eq("configured", false)),
    cj_with_variant: count(db, "supplier_listings", (q) => q.eq("supplier", "cj").not("supplier_variant_id", "is", null)),
    cj_verified: count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("verification_status", "verified")),
    cj_due_for_verification: count(db, "supplier_listings", (q) =>
      q.eq("supplier", "cj")
        .not("supplier_variant_id", "is", null)
        .in("verification_status", ["unverified", "retryable"])
        .or(`next_verification_at.is.null,next_verification_at.lte.${nowIso}`)),
    cj_retryable: count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("verification_status", "retryable")),
    cj_unavailable: count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("verification_status", "unavailable")),
    shop_listings: count(db, "shop_listings"),
    shop_listings_published: count(db, "shop_listings", (q) => q.eq("published", true)),
    shop_listings_published_orderable: count(db, "shop_listings", (q) => q.eq("published", true).eq("orderable", true).gt("inventory", 0)),
    shop_listings_on_base: count(db, "shop_listings", (q) => q.not("base_item_id", "is", null)),
    shop_listings_on_base_published: count(db, "shop_listings", (q) => q.not("base_item_id", "is", null).eq("published", true).eq("base_publication_status", "published")),
    // Durable provenance marker written by both Sales Test Gate paths.
    shop_listings_sales_test_gate_passed: count(db, "shop_listings", (q) =>
      q.filter("selection_reasons", "cs", JSON.stringify(["sales_test_gate_passed"]))),
    shop_listings_reason_sales_test_gate_passed: count(db, "shop_listings", (q) =>
      q.eq("pipeline_reason", "sales_test_gate_passed")),
    shop_listings_published_inventory_unknown: count(db, "shop_listings", (q) => q.eq("published", true).is("inventory", null)),
    shop_listings_published_not_orderable: count(db, "shop_listings", (q) => q.eq("published", true).eq("orderable", false)),
    newfind_deliveries: count(db, "newfind_promotion_deliveries"),
    newfind_deliveries_processed: count(db, "newfind_promotion_deliveries", (q) => q.eq("status", "processed")),
    newfind_deliveries_failed: count(db, "newfind_promotion_deliveries", (q) => q.eq("status", "failed")),
    purchase_orders_supplier_payment_pending: count(db, "purchase_orders", (q) => q.eq("status", "supplier_payment_pending")),
    purchase_orders_supplier_payment_verification_failed: count(db, "purchase_orders", (q) => q.eq("status", "supplier_payment_verification_failed")),
    purchase_orders_supplier_payment_confirmed: count(db, "purchase_orders", (q) => q.eq("supplier_status", "paid")),
    purchase_orders_failed: count(db, "purchase_orders", (q) => q.in("status", ["failed", "cancelled"])),
    shop_orders: count(db, "shop_orders"),
    purchase_orders: count(db, "purchase_orders"),
    supplier_order_attempts: count(db, "supplier_order_attempts"),
  };

  const counts = Object.fromEntries(
    await Promise.all(Object.entries(entries).map(async ([key, value]) => [key, await value])),
  );

  const [{ data: recentPublished }, { data: recentOrders }, { data: blockedReasons }] = await Promise.all([
    db.from("shop_listings")
      .select("id,slug,title,selling_price,inventory,orderable,published,base_item_id,base_publication_status,pipeline_reason,updated_at")
      .eq("published", true)
      .not("shopify_product_id", "is", null)
      .eq("shopify_sync_status", "synced")
      .eq("orderable", true)
      .eq("tracking_available", true)
      .gt("inventory", 0)
      .gt("selling_price", 0)
      .eq("currency", "JPY")
      .order("updated_at", { ascending: false })
      .limit(50),
    db.from("shop_orders")
      .select("id,order_status,created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    db.from("shop_listings")
      .select("pipeline_reason")
      .eq("pipeline_status", "blocked")
      .limit(1000),
  ]);

  // Duplicate detection: one external object must map to one TRACER row.
  const duplicates = async (table: string, column: string): Promise<number | string> => {
    const { data, error } = await db.from(table).select(column).not(column, "is", null).limit(10000);
    if (error) return `error: ${error.message}`;
    const seen = new Map<string, number>();
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const key = String(row[column]);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return Array.from(seen.values()).filter((n) => n > 1).length;
  };
  const [duplicateBaseItems, duplicateSupplierOrders, duplicateNewfindDeliveries] = await Promise.all([
    duplicates("shop_listings", "base_item_id"),
    duplicates("purchase_orders", "supplier_order_id"),
    duplicates("newfind_promotion_deliveries", "listing_id"),
  ]);

  const genericTitles = new Set([
    "スマホ保護アクセサリー",
    "暮らしの便利アイテム",
    "インテリア照明",
    "キッチン用品",
    "ペット用品",
    "バスルームマット",
    "トレンド・seeded_dueアイテム",
  ]);
  const storefrontRecentPublished = (recentPublished ?? []).filter((row) => {
    const title = String(row.title ?? "").normalize("NFKC").trim();
    return /[ぁ-んァ-ヶ一-龯々ー]/u.test(title) && !genericTitles.has(title);
  }).slice(0, 15);

  const blocked: Record<string, number> = {};
  for (const row of blockedReasons ?? []) {
    const reason = String(row.pipeline_reason ?? "unknown");
    blocked[reason] = (blocked[reason] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    generatedAt: nowIso,
    // Which commit production is actually serving (set by Vercel at build).
    deployment: {
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      env: process.env.VERCEL_ENV ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
    counts,
    duplicates: {
      base_item_id: duplicateBaseItems,
      supplier_order_id: duplicateSupplierOrders,
      newfind_listing_id: duplicateNewfindDeliveries,
    },
    shopListingBlockedReasons: blocked,
    recentPublished: storefrontRecentPublished,
    recentOrders: recentOrders ?? [],
  });
}
