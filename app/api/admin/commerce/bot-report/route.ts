import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildRoleReport, type RoleName } from "@/lib/ops/grok-commerce-role-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type CountResult = { count: number; error: string | null };

type CountFilter = { column: string; operator: "eq" | "gte"; value: string };

async function exactCount(db: ReturnType<typeof createSupabaseAdminClient>, table: string, filter?: CountFilter): Promise<CountResult> {
  let query = db.from(table).select("*", { count: "exact", head: true });
  if (filter?.operator === "eq") query = query.eq(filter.column, filter.value);
  if (filter?.operator === "gte") query = query.gte(filter.column, filter.value);
  const { count, error } = await query;
  return { count: count ?? 0, error: error?.message ?? null };
}

/**
 * Authenticated, read-only role dashboard. Counts are diagnostics, not proof that
 * individual listings are sellable or that provider state matches canonical state.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const db = createSupabaseAdminClient();
    const [products, variants, offers, offerErrors, channelListings, listingErrors, cronRuns, cronFailures] = await Promise.all([
      exactCount(db, "commerce_products"),
      exactCount(db, "commerce_variants"),
      exactCount(db, "supplier_offers"),
      exactCount(db, "supplier_offers", { column: "source_status", operator: "eq", value: "error" }),
      exactCount(db, "channel_listings"),
      exactCount(db, "channel_listings", { column: "status", operator: "eq", value: "error" }),
      exactCount(db, "cron_runs", { column: "started_at", operator: "gte", value: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
      exactCount(db, "cron_runs", { column: "started_at", operator: "gte", value: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
    ]);

    const sources = { products, variants, offers, offerErrors, channelListings, listingErrors, cronRuns, cronFailures };
    const errors = Object.entries(sources).filter(([, value]) => value.error).map(([name, value]) => ({
      source: name,
      error: value.error,
    }));
    const runId = `readonly-${new Date().toISOString()}`;
    const role = (name: RoleName, scanned: number, failed: number, notes: string[]) =>
      buildRoleReport({
        runId,
        role: name,
        scanned,
        changed: 0,
        failed: errors.length ? Math.max(1, failed) : failed,
        skipped: 0,
        writesPerformed: false,
        evidenceRefs: ["supabase:exact-counts"],
        notes,
      });

    const reports = [
      role("main", products.count + variants.count + offers.count + channelListings.count, errors.length, [
        "Read-only count summary; no provider mutations were attempted.",
        "Counts do not establish product-level sellability or channel parity.",
      ]),
      role("product_monitor", offers.count, offerErrors.count, [
        `Supplier offers in catalog: ${offers.count}; source_status=error: ${offerErrors.count}.`,
        "Stock, landed cost, Japan shipping, and supplier variant identity require per-offer evidence checks.",
      ]),
      role("japanese_localization", variants.count, 0, [
        `Variants scanned by count only: ${variants.count}.`,
        "This endpoint does not read or modify title/description text.",
      ]),
      role("channel_sync", channelListings.count, listingErrors.count, [
        `Channel listings: ${channelListings.count}; status=error: ${listingErrors.count}.`,
        "Cross-channel price, inventory, published state, SKU, and title parity are not inferred from counts.",
      ]),
      role("qa", cronRuns.count, cronFailures.count, [
        `Cron runs in last 24 hours: ${cronRuns.count}; failed: ${cronFailures.count}.`,
        "No writes, orders, publication changes, or external provider requests were performed.",
      ]),
    ];

    return NextResponse.json({
      ok: errors.length === 0,
      readOnly: true,
      writesPerformed: false,
      generatedAt: new Date().toISOString(),
      scope: "aggregate_counts_only",
      reports,
      dataErrors: errors,
      limitations: [
        "Aggregate counts are not a product-level audit.",
        "BASE, Shopify, and NEWFIND live readback is not performed by this endpoint.",
        "No product, listing, order, or procurement data was changed.",
      ],
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({
      ok: false,
      readOnly: true,
      writesPerformed: false,
      error: "commerce_bot_report_unavailable",
    }, { status: 500, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
