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

  const startedAt = new Date().toISOString();
  const before = await audit(request);
  const repairs: string[] = [];
  const results: unknown[] = [];

  const orderable = count(before, "supplier_listings_orderable");
  const due = count(before, "cj_due_for_verification");
  const retryable = count(before, "cj_retryable");
  const basePublished = count(before, "shop_listings_on_base_published");

  if (orderable === 0 || due > 0 || retryable > 0) {
    repairs.push("supply-first");
    results.push(await repair(request, "supply-first"));
  }

  const afterSupply = await audit(request);
  if (count(afterSupply, "supplier_listings_orderable") > 0 && basePublished === 0) {
    repairs.push("base-publish");
    results.push(await repair(request, "base-publish"));
  }

  const after = await audit(request);
  const report = {
    patrol: "TRACER Production Patrol",
    startedAt,
    finishedAt: new Date().toISOString(),
    repairs,
    before,
    after,
    results,
    verdict: count(after, "supplier_listings_orderable") > 0 ? "SUPPLY_AVAILABLE" : "SUPPLY_STILL_BLOCKED",
  };
  console.log("[TRACER_PATROL]", JSON.stringify(report));
  return NextResponse.json(report);
}
