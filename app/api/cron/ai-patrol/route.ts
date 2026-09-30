import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { decidePatrolAction } from "@/lib/ops/patrol-ai";

export const runtime = "nodejs";
export const maxDuration = 300;

const BASE = "https://tracer-self.vercel.app";

async function getAudit(token: string) {
  const response = await fetch(`${BASE}/api/intelligence/pipeline-audit`, {
    headers: { Authorization: token },
    cache: "no-store",
  });
  const body = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch {}
  if (!response.ok) throw new Error(`pipeline-audit ${response.status}: ${body.slice(0, 500)}`);
  return json as Record<string, unknown>;
}

async function runCron(path: string, token: string) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: token },
    cache: "no-store",
  });
  const body = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch {}
  return { status: response.status, ok: response.ok, body: json ?? body.slice(0, 1000) };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const token = request.headers.get("authorization") ?? "";
  const startedAt = Date.now();

  try {
    const before = await getAudit(token);
    const decision = decidePatrolAction(before as { counts?: Record<string, number | string>; recentPublished?: Array<Record<string, unknown>> });

    let repair: unknown = null;
    if (decision.action === "repair_first_cj") {
      repair = await runCron("/api/admin/repair-first-cj-listing", token);
    } else if (decision.action === "run_supply_first") {
      repair = await runCron("/api/cron/supply-first", token);
    }

    const after = await getAudit(token);

    return NextResponse.json({
      ok: true,
      agent: "TRACER Autonomous Patrol AI",
      elapsedMs: Date.now() - startedAt,
      decision,
      repair,
      before,
      after,
      changedCounts: diffCounts(
        (before.counts ?? {}) as Record<string, number | string>,
        (after.counts ?? {}) as Record<string, number | string>,
      ),
    });
  } catch (error) {
    console.error("[TRACER PATROL AI]", error);
    return NextResponse.json({
      ok: false,
      agent: "TRACER Autonomous Patrol AI",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

function diffCounts(before: Record<string, number | string>, after: Record<string, number | string>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries([...keys].sort().map((key) => {
    const b = Number(before[key]);
    const a = Number(after[key]);
    return [key, Number.isFinite(b) && Number.isFinite(a) ? { before: b, after: a, delta: a - b } : { before: before[key] ?? null, after: after[key] ?? null }];
  }));
}
