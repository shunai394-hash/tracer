import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";

export const runtime = "nodejs";
export const maxDuration = 300;

const DISCOVERY_BUDGET_MS = 240_000;
// CJ live verification is already deadline-bounded; use the full 4-minute
// window to recover the remaining real supplier catalog instead of stopping
// after ten candidates.
const DISCOVERY_BATCH_SIZE = 40;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let db: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let runId: string | null = null;

  try {
    db = createSupabaseAdminClient();

    // Check the persisted CJ quota circuit before creating a new run record or
    // invoking discovery. Vercel invokes this route every five minutes; while
    // the provider cooldown is active, those invocations must be cheap no-ops
    // and must not create misleading "processed 0" catalog runs.
    const { data: quotaRun, error: quotaReadError } = await db
      .from("cron_runs")
      .select("metadata")
      .eq("job_name", "cj-api-quota-circuit")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (quotaReadError) {
      throw new Error(`CJ quota circuit lookup failed: ${quotaReadError.message}`);
    }
    const quotaMetadata = quotaRun?.metadata && typeof quotaRun.metadata === "object" && !Array.isArray(quotaRun.metadata)
      ? quotaRun.metadata as Record<string, unknown>
      : {};
    const blockedUntil = typeof quotaMetadata.blockedUntil === "string" ? quotaMetadata.blockedUntil : null;
    const quotaCircuitActive = isCJQuotaCircuitActive(quotaMetadata);

    const { data: run, error: startError } = await db.from("cron_runs").insert({
      job_name: "supply-first",
      status: "running",
      started_at: startedAtIso,
      processed: 0,
      failed: 0,
      metadata: { actor: "vercel-cron", batchSize: DISCOVERY_BATCH_SIZE, deadlineMs: DISCOVERY_BUDGET_MS },
    }).select("id").maybeSingle();
    if (startError) {
      console.error("[TRACER SUPPLY-FIRST RUN LOG START FAILED]", { stage: "cron_run_insert", code: startError.code ?? null });
    } else if (run?.id) {
      runId = String(run.id);
    }

    // A CJ quota cooldown must stop new CJ API calls, not stop the rest of
    // the sales pipeline. Re-check already persisted, explicitly orderable offers
    // and let the normal publication gate decide whether any are still sellable.
    const cachedSupply = quotaCircuitActive
      ? await db.from("supplier_listings")
          .select("product_id")
          .eq("price_confirmed", true)
          .eq("inventory_confirmed", true)
          .eq("orderable", true)
          .eq("tracking_available", true)
          .eq("api_available", true)
          .gt("inventory", 0)
          .limit(DISCOVERY_BATCH_SIZE)
      : null;
    if (cachedSupply?.error) throw new Error(`cached orderable supply lookup failed: ${cachedSupply.error.message}`);

    const supplyFirst: { items: unknown[]; discovered?: number; published?: number; rejected?: number; eligibleCount?: number; deadlineReached?: boolean; verified?: number; candidateCount?: number; quotaBlocked?: boolean; retryable?: boolean; retryAfter?: string | null; reason?: string } = quotaCircuitActive
      ? {
          items: (cachedSupply?.data ?? []).map((row) => ({ productId: String(row.product_id ?? "") })).filter((row) => row.productId),
          discovered: 0,
          published: 0,
          rejected: 0,
          eligibleCount: 0,
          deadlineReached: false,
          verified: cachedSupply?.data?.length ?? 0,
          candidateCount: cachedSupply?.data?.length ?? 0,
          quotaBlocked: true,
          retryable: true,
          retryAfter: blockedUntil ?? undefined,
          reason: "cj_quota_cooldown_using_cached_orderable_supply",
        }
      : await discoverAndCreateCjSupply(DISCOVERY_BATCH_SIZE, {
          deadlineAt: startedAt + DISCOVERY_BUDGET_MS,
        });

    const verifiedProductIds = (supplyFirst.items ?? [])
      .map((item) => (item && typeof item === "object" && "productId" in item ? String((item as { productId?: unknown }).productId ?? "") : ""))
      .filter(Boolean);
    const opportunityIntelligence = verifiedProductIds.length > 0 && Date.now() - startedAt < 210_000
      ? await buildOpportunityIntelligence({ productIds: verifiedProductIds })
          .then((result) => ({ productIds: verifiedProductIds, processed: result.processed, testReady: result.testReady }))
          .catch((error) => ({ productIds: verifiedProductIds, error: error instanceof Error ? error.message : String(error) }))
      : { skipped: true, reason: verifiedProductIds.length > 0 ? "time_budget" : "no_verified_products" };

    // Continue the same real pipeline from verified supply into sales-test selection
    // and all three delivery channels. The selector remains the single profitability,
    // stock, shipping and supplier-evidence gate; no raw discovery candidate is published.
    let publication: Record<string, unknown> = { skipped: true, reason: "no_verified_products" };
    if (
      verifiedProductIds.length > 0 &&
      !("error" in opportunityIntelligence) &&
      Date.now() - startedAt < 225_000
    ) {
      const selected = await selectAndPublishSupplySalesTests(verifiedProductIds, 40, {
        allowNativeCjIdentity: process.env.TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED !== "false",
      });
      const listingIds = selected.selectedListingIds;
      if (listingIds.length > 0) {
        const shopify = await syncPublishedListingsToShopify(listingIds)
          .then((result) => ({ ok: result.failed.length === 0, ...result }))
          .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        const shopifySyncedListingIds = "listingIds" in shopify ? shopify.listingIds : [];
        const newfind = await Promise.all(shopifySyncedListingIds.map((listingId) => promoteShopListingToNewfind(listingId)
          .catch((error) => ({ configured: true, sent: false, eventId: "tracer-shop-listing:" + listingId, status: null, ackStatus: null, detail: error instanceof Error ? error.message : String(error) }))));
        const base = await publishPublishedListingsToBase(40, listingIds)
          .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error), published: 0, failed: listingIds.length }));
        publication = {
          considered: selected.considered,
          published: selected.published,
          rejected: selected.rejected.length,
          rejectedReasons: selected.rejected.reduce<Record<string, number>>((counts, item) => {
            for (const reason of item.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
            return counts;
          }, {}),
          listingIds,
          shopify,
          base,
          newfindSent: newfind.filter((item) => item.sent).length,
          newfind,
        };
      } else {
        publication = {
          considered: selected.considered,
          published: selected.published,
          rejected: selected.rejected.length,
          rejectedReasons: selected.rejected.reduce<Record<string, number>>((counts, item) => {
            for (const reason of item.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
            return counts;
          }, {}),
          reason: "no_listing_passed_profitability_and_live_supply_gate",
        };
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (db && runId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: elapsedMs,
        processed: verifiedProductIds.length,
        failed: 0,
        metadata: {
          actor: "vercel-cron",
          batchSize: DISCOVERY_BATCH_SIZE,
          deadlineMs: DISCOVERY_BUDGET_MS,
          reason: typeof supplyFirst.reason === "string" ? supplyFirst.reason : null,
          retryable: supplyFirst.retryable === true,
          quotaBlocked: supplyFirst.quotaBlocked === true,
          deadlineReached: supplyFirst.deadlineReached === true,
          candidateCount: Number(supplyFirst.candidateCount ?? 0),
          discovered: Number(supplyFirst.discovered ?? 0),
          verified: Number(supplyFirst.verified ?? verifiedProductIds.length),
          published: Number(supplyFirst.published ?? 0),
          retryAfter: typeof supplyFirst.retryAfter === "string" ? supplyFirst.retryAfter : null,
          opportunityIntelligence: {
            skipped: typeof opportunityIntelligence === "object" && opportunityIntelligence !== null && "skipped" in opportunityIntelligence
              ? Boolean(opportunityIntelligence.skipped)
              : false,
            processed: typeof opportunityIntelligence === "object" && opportunityIntelligence !== null && "processed" in opportunityIntelligence
              ? Number(opportunityIntelligence.processed)
              : 0,
          },
          publication,
        },
      }).eq("id", runId);
      if (finishError) console.error("[TRACER SUPPLY-FIRST RUN LOG FINISH FAILED]", { stage: "cron_run_update", code: finishError.code ?? null });
    }

    return NextResponse.json({
      ok: true,
      elapsedMs,
      supplyFirst,
      opportunityIntelligence,
      publication,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const stage = message.split(":")[0].slice(0, 100);
    if (db && runId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: 0,
        failed: 1,
        error: stage,
        metadata: { actor: "vercel-cron", batchSize: DISCOVERY_BATCH_SIZE, deadlineMs: DISCOVERY_BUDGET_MS, errorStage: stage },
      }).eq("id", runId);
      if (finishError) console.error("[TRACER SUPPLY-FIRST RUN LOG FAILURE UPDATE FAILED]", { stage: "cron_run_update", code: finishError.code ?? null });
    }
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", { stage });
    return NextResponse.json(
      { ok: false, error: stage },
      { status: 500 },
    );
  }
}