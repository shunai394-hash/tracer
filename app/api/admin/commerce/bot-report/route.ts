import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildRoleReport, type RoleName } from "@/lib/ops/grok-commerce-role-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type CountResult = { count: number; error: string | null };

async function exactCount(db: ReturnType<typeof createSupabaseAdminClient>, table: string, filter?: { column: string; value: string; since?: string }) {
  let query = db.from(table).select("*", { count: "exact", head: true });
  if (filter) query = filter.since ? query.gte(filter.column, filter.since) : query.eq(filter.column, filter.value);
  const { count, error } = await query;
  return { count: count ?? 0, error: error?.message ?? null } satisfies CountResult;
}

/** Aggregate diagnostics only. This endpoint never mutates commerce data. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const db = createSupabaseAdminClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [products, variants, offers, offerErrors, listings, listingErrors, cronRuns, cronFailures] = await Promise.all([
      exactCount(db, "commerce_products"),
      exactCount(db, "commerce_variants"),
      exactCount(db, "supplier_offers"),
      exactCount(db, "supplier_offers", { column: "source_status", value: "error" }),
      exactCount(db, "channel_listings"),
      exactCount(db, "channel_listings", { column: "status", value: "error" }),
      exactCount(db, "cron_runs", { column: "started_at", value: "", since }),
      exactCount(db, "cron_runs", { column: "started_at", value: "", since }),
    ]);
    const sources = { products, variants, offers, offerErrors, listings, listingErrors, cronRuns, cronFailures };
    const dataErrors = Object.entries(sources).filter(([, v]) => v.error).map(([source, v]) => ({ source, error: v.error }));
    const runId = `readonly-${new Date().toISOString()}`;
    const report = (role: RoleName, scanned: number, failed: number, notes: string[]) => buildRoleReport({
      runId, role, scanned, changed: 0, failed: dataErrors.length ? Math.max(1, failed) : failed,
      skipped: 0, writesPerformed: false, evidenceRefs: ["supabase:exact-counts"], notes,
    });
    const reports = [
      report("main", products.count + variants.count + offers.count + listings.count, dataErrors.length, [
        "Aggregate counts only; no provider mutations attempted.",
        "Counts do not prove per-product sellability or channel parity.",
      ]),
      report("product_monitor", offers.count, offerErrors.count, ["Supplier offer count and source_status=error count only; freshness, stock, cost and shipping are not verified."]),
      report("japanese_localization", variants.count, 0, ["Variant count only; title and description text are not read or modified."]),
      report("channel_sync", listings.count, listingErrors.count, ["Listing count and status=error count only; live BASE, Shopify and NEWFIND parity is not checked."]),
      report("qa", cronRuns.count, cronFailures.count, ["Cron count query is a 24-hour diagnostic; no writes, orders or publication changes were performed."]),
    ];
    return NextResponse.json({
      ok: dataErrors.length === 0, readOnly: true, writesPerformed: false,
      generatedAt: new Date().toISOString(), scope: "aggregate_counts_only", reports, dataErrors,
      limitations: ["Aggregate counts are not a product-level audit.", "BASE, Shopify and NEWFIND live readback is not performed.", "No product, listing, order or procurement data was changed."],
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ ok: false, readOnly: true, writesPerformed: false, error: "commerce_bot_report_unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
