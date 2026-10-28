import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 50;
  const runId = url.searchParams.get("runId");
  const botId = url.searchParams.get("botId");
  const validBots = ["main", "product-monitor", "japanese-copy", "channel-sync", "qa"];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (runId && !uuid.test(runId)) return NextResponse.json({ error: "invalid_run_id" }, { status: 400 });
  if (botId && !validBots.includes(botId)) return NextResponse.json({ error: "invalid_bot_id" }, { status: 400 });

  try {
    const supabase = createSupabaseAdminClient();
    let query = supabase.from("commerce_bot_run_events")
      .select("id,run_id,bot_id,event_type,status,occurred_at,evidence_refs,blockers,retry_count,metadata")
      .order("occurred_at", { ascending: false }).limit(limit);
    if (runId) query = query.eq("run_id", runId);
    if (botId) query = query.eq("bot_id", botId);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "run_history_unavailable" }, { status: 503 });
    return NextResponse.json({ events: data ?? [], count: data?.length ?? 0, limit }, {
      headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return NextResponse.json({ error: "run_history_unavailable" }, { status: 503 });
  }
}
