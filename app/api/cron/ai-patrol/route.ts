import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { decidePatrolAction } from "@/lib/ops/patrol-ai";

export const runtime = "nodejs";
export const maxDuration = 300;

const BASE = "https://tracer-naito3087.vercel.app";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const token = request.headers.get("authorization") ?? "";
  const response = await fetch(BASE + "/api/cron/patrol-ai", {
    headers: { Authorization: token },
    cache: "no-store",
  });
  const body = await response.text();
  let json: unknown = body;
  try { json = JSON.parse(body); } catch {}
  return NextResponse.json({
    ok: response.ok,
    agent: "TRACER Autonomous Patrol AI",
    delegatedTo: "/api/cron/patrol-ai",
    result: json,
  }, { status: response.status });
}
