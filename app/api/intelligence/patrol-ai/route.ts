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

async function repair(request: Request, stage: string) {
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
 * Production Patrol: measure the live funnel, choose a bounded repair, execute
 * it, then measure again. It never invents data and never places a purchase.
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

  console.log("[TRACER_PATROL_BEFORE]", JSON.stringify({
    patrolId,
    orderable,
    due,
    retryable,
    basePublished,
    deployment: before.deployment,
  }));

  const decision = orderable === 0 || due > 0 || retryable > 0
    ? "repair_first_supply_first"
    : "observe";
  console.log("[TRACER_PATROL_DECISION]", JSON.stringify({
    patrolId,
    action: decision,
    reason: { orderable, due, retryable },
  }));

  if (decision === "repair_first_supply_first") {
    repairs.push("supply-first");
    const result = await repair(request, "supply-first");
    results.push(result);
    console.log("[TRACER_PATROL_REPAIR]", JSON.stringify({
      patrolId,
      stage: "supply-first",
      status: result.status,
      ok: result.ok,
    }));
  }


  const after = await audit(request);
  const verdict = count(after, "supplier_listings_orderable") > 0
    ? "SUPPLY_AVAILABLE"
    : "SUPPLY_STILL_BLOCKED";

  console.log("[TRACER_PATROL_AFTER]", JSON.stringify({
    patrolId,
    orderable: count(after, "supplier_listings_orderable"),
    due: count(after, "cj_due_for_verification"),
    retryable: count(after, "cj_retryable"),
    basePublished: count(after, "shop_listings_on_base_published"),
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
  };
  console.log("[TRACER_PATROL_COMPLETE]", JSON.stringify({
    patrolId,
    finishedAt,
    verdict,
    repairs,
    before: { orderable, due, retryable, basePublished },
    after: {
      orderable: count(after, "supplier_listings_orderable"),
      due: count(after, "cj_due_for_verification"),
      retryable: count(after, "cj_retryable"),
      basePublished: count(after, "shop_listings_on_base_published"),
    },
  }));
  return NextResponse.json(report);
}
