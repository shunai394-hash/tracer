import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";\nimport { discoverSuperDeliverySupply } from "@/lib/suppliers/discover-superdelivery-supply";

export const runtime = "nodejs";
export const maxDuration = 60;

const JOB_NAME = "superdelivery-sales-route";
const DISCOVERY_BATCH_SIZE = 5;
const GATE_LIMIT = 2;
const STAGE_BUDGETS_MS = {
  discovery: 12_000,
  intelligence: 8_000,
  gate: 6_000,
  base: 8_000,
  newfind: 5_000,
} as const;

async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_time_budget_exceeded`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  let cronRunId: string | null = null;

  try {
    await recoverStaleCronRun(db, JOB_NAME, 60);

    const { data: cronRun, error: claimError } = await db
      .from("cron_runs")
      .insert({
        job_name: JOB_NAME,
        status: "running",
        metadata: {
          route: "SUPER_DELIVERY -> TRACER -> SALES_TEST_GATE -> BASE -> NEWFIND",
          discoveryBatchSize: DISCOVERY_BATCH_SIZE,
          gateLimit: GATE_LIMIT,
        },
      })
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: JOB_NAME },
          { status: 409 },
        );
      }
      throw new Error(claimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    // 1. SUPER DELIVERY -> TRACER. ProductSetSearch is fetched once and the
    // JAN matching itself is local, so discovery can safely drain a bounded
    // batch without multiplying supplier API calls.
    const discovery = await withinBudget(
      discoverSuperDeliverySupply(DISCOVERY_BATCH_SIZE),
      STAGE_BUDGETS_MS.discovery,
      "superdelivery_discovery",
    );

    // 2. Recalculate the same opportunity evidence used by the Sales Test Gate.
    await withinBudget(
      buildOpportunityIntelligence(),
      STAGE_BUDGETS_MS.intelligence,
      "opportunity_intelligence",
    );

    // 3. SALES TEST GATE. This function is the only code allowed to set
    // shop_listings.published=true.
    const gate = await selectAndPublishSupplySalesTests(
      discovery.gateCandidates,
      GATE_LIMIT,
    );

    // 4. BASE. Only Gate-passed listings are considered for a new BASE item.
    const base = await withinBudget(
      publishPublishedListingsToBase(GATE_LIMIT, gate.publishedListingIds),
      STAGE_BUDGETS_MS.base,
      "base_publication",
    );

    // 5. NEWFIND. Only listings that are still Gate-passed AND have a BASE item
    // are promoted by this route. The NEWFIND function re-checks the Gate.
    const baseReadyListingIds = gate.publishedListingIds.length
      ? (
          await db
            .from("shop_listings")
            .select("id")
            .in("id", gate.publishedListingIds)
            .not("base_item_id", "is", null)
            .eq("published", true)
        ).data?.map((row) => String(row.id)) ?? []
      : [];

    const newfind = [];
    for (const listingId of baseReadyListingIds) {
      try {
        newfind.push(
          await withinBudget(
            promoteShopListingToNewfind(listingId),
            STAGE_BUDGETS_MS.newfind,
            "newfind_promotion",
          ),
        );
      } catch (error) {
        newfind.push({
          listingId,
          sent: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = {
      ok: true,
      route: "SUPER_DELIVERY -> TRACER -> SALES_TEST_GATE -> BASE -> NEWFIND",
      elapsedMs: Date.now() - startedAt,
      stages: {
        superdelivery: discovery,
        salesTestGate: gate,
        base,
        newfind,
      },
    };

    if (cronRunId) {
      await db
        .from("cron_runs")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: discovery.considered,
          failed: discovery.blocked.length + gate.rejected.length + base.failed,
          metadata: result,
        })
        .eq("id", cronRunId);
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (cronRunId) {
      await db
        .from("cron_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error: message,
        })
        .eq("id", cronRunId);
    }

    console.error("[TRACER SUPER DELIVERY SALES ROUTE ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        route: "SUPER_DELIVERY -> TRACER -> SALES_TEST_GATE -> BASE -> NEWFIND",
        error: message,
      },
      { status: 500 },
    );
  }
}
