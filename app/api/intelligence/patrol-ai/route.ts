import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

type Audit = {
  ok?: boolean;
  generatedAt?: string;
  deployment?: { commitSha?: string | null; env?: string | null };
  counts?: Record<string, number | string>;
  shopListingBlockedReasons?: Record<string, number>;
};

function count(audit: Audit, key: string): number {
  const value = audit.counts?.[key];
  return typeof value === "number" ? value : Number(value) || 0;
}

async function audit(request: Request): Promise<Audit> {
  const origin = new URL(request.url).origin;
  const response = await fetch(`${origin}/api/intelligence/pipeline-audit`, {
    headers: { Authorization: request.headers.get("authorization") ?? "" },
    cache: "no-store",
  });
  return (await response.json()) as Audit;
}

async function runStage(request: Request, stage: string) {
  const origin = new URL(request.url).origin;
  const response = await fetch(`${origin}/api/cron/${stage}`, {
    headers: { Authorization: request.headers.get("authorization") ?? "" },
    cache: "no-store",
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch {}
  return { stage, status: response.status, ok: response.ok, body };
}

/**
 * Production Patrol: measure the live funnel, run the full intelligence loop,
 * then use supply-first only as a bounded fallback when the intelligence cron
 * itself fails. It never invents data and never places a purchase.
 *
 * Important: supply availability must not short-circuit Market -> Identity ->
 * Demand -> Opportunity -> Sales Test Gate. Previously, any due supply row
 * caused patrol-ai to run only supply-first forever.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const patrolId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  console.log("[TRACER_PATROL_START]", JSON.stringify({ patrolId, startedAt }));

  const before = await audit(request);
  const repairs: string[] = [];
  const results: unknown[] = [];

  const orderable = count(before, "supplier_listings_orderable");
  const due = count(before, "cj_due_for_verification");
  const retryable = count(before, "cj_retryable");
  const basePublished = count(before, "shop_listings_on_base_published");
  const gatePublishedBefore = count(before, "sales_test_gate_published");

  console.log("[TRACER_PATROL_BEFORE]", JSON.stringify({
    patrolId,
    orderable,
    due,
    retryable,
    basePublished,
    gatePublishedBefore,
    deployment: before.deployment,
  }));

  const intelligence = await runStage(request, "intelligence");
  repairs.push("intelligence");
  results.push(intelligence);
  console.log("[TRACER_PATROL_INTELLIGENCE]", JSON.stringify({
    patrolId,
    status: intelligence.status,
    ok: intelligence.ok,
  }));

  if (!intelligence.ok && (due > 0 || retryable > 0 || orderable === 0)) {
    const fallback = await runStage(request, "supply-first");
    repairs.push("supply-first-fallback");
    results.push(fallback);
    console.log("[TRACER_PATROL_FALLBACK]", JSON.stringify({
      patrolId,
      stage: "supply-first",
      status: fallback.status,
      ok: fallback.ok,
    }));
  }

  const after = await audit(request);
  const gatePublishedAfter = count(after, "sales_test_gate_published");
  const newGatePublished = Math.max(0, gatePublishedAfter - gatePublishedBefore);
  const verdict =
    newGatePublished > 0
      ? "SALES_TEST_GATE_PROGRESS"
      : intelligence.ok
        ? "INTELLIGENCE_CYCLE_COMPLETE"
        : "INTELLIGENCE_CYCLE_FAILED";

  console.log("[TRACER_PATROL_AFTER]", JSON.stringify({
    patrolId,
    orderable: count(after, "supplier_listings_orderable"),
    due: count(after, "cj_due_for_verification"),
    retryable: count(after, "cj_retryable"),
    basePublished: count(after, "shop_listings_on_base_published"),
    gatePublishedBefore,
    gatePublishedAfter,
    newGatePublished,
    deployment: after.deployment,
  }));

  const finishedAt = new Date().toISOString();
  const report = {
    patrol: "TRACER Production Patrol",
    patrolId,
    startedAt,
    finishedAt,
    repairs,
    before,
    after,
    results,
    verdict,
    gateProgress: {
      before: gatePublishedBefore,
      after: gatePublishedAfter,
      newPublished: newGatePublished,
    },
  };
  console.log("[TRACER_PATROL_COMPLETE]", JSON.stringify({
    patrolId,
    finishedAt,
    verdict,
    repairs,
    gateProgress: {
      before: gatePublishedBefore,
      after: gatePublishedAfter,
      newPublished: newGatePublished,
    },
  }));
  return NextResponse.json(report);
}
