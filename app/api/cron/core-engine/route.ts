import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

function key(row: Record<string, unknown>) {
  for (const field of ["jan", "gtin", "ean", "upc", "mpn", "asin"]) {
    const value = typeof row[field] === "string" ? row[field].trim().toLowerCase() : "";
    if (value) return value;
  }
  return "title:" + String(row.title ?? "").trim().toLowerCase();
}

function score(row: Record<string, unknown>) {
  const rank = Number(row.rank ?? 0);
  const reviews = Number(row.review_count ?? 0);
  const hasId = ["jan", "gtin", "ean", "upc", "mpn"].some((f) => Boolean(row[f]));
  const demand = rank > 0 ? Math.max(0, Math.min(100, 100 - rank / 10)) : 0;
  const pain = Math.max(0, Math.min(100, Math.log1p(reviews) * 12));
  const identity = hasId ? 100 : row.asin ? 80 : 20;
  const competition = reviews > 1000 ? 20 : 60;
  return {
    demand,
    pain,
    identity: hasId ? 1 : row.asin ? 0.9 : 0.2,
    overall: demand * .3 + pain * .2 + (row.price ? 50 : 0) * .15 + identity * .2 + competition * .15,
  };
}

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase
    .from("tracer_core_runs")
    .insert({ run_type: "candidate-refresh", status: "running", started_at: startedAt })
    .select("id")
    .single();
  if (runError) return NextResponse.json({ ok: false, error: runError.message }, { status: 500 });

  try {
    const { data, error } = await supabase
      .from("marketplace_bestsellers")
      .select("id,title,brand,image_url,product_url,source_url,rank,review_count,price,currency,jan,gtin,ean,upc,mpn,asin,marketplace,source,fetched_at,metadata")
      .order("fetched_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);

    const unique = new Map<string, Record<string, unknown>>();
    for (const row of data ?? []) {
      const k = key(row as Record<string, unknown>);
      if (!unique.has(k)) unique.set(k, row as Record<string, unknown>);
    }

    const candidates = [...unique.entries()].map(([canonicalKey, row]) => {
      const s = score(row);
      const qualified = s.identity >= .88 && Boolean(row.price);
      return {
        bestseller_id: row.id,
        canonical_key: canonicalKey,
        title: String(row.title ?? "unknown product"),
        brand: row.brand ? String(row.brand) : null,
        image_url: row.image_url ? String(row.image_url) : null,
        source_url: row.product_url ?? row.source_url ?? null,
        demand_score: s.demand,
        pain_score: s.pain,
        market_gap_score: row.price ? 50 : 0,
        supply_score: 0,
        margin_score: row.price ? 50 : 0,
        competition_score: Number(row.review_count ?? 0) > 1000 ? 20 : 60,
        identity_confidence: s.identity,
        overall_score: s.overall,
        state: qualified ? "QUALIFIED" : row.asin ? "IDENTITY_PENDING" : "NEEDS_IDENTITY",
        evidence: { marketplace: row.marketplace, source: row.source, rank: row.rank, reviews: row.review_count, price: row.price, currency: row.currency },
        metadata: row.metadata ?? {},
        last_evaluated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    if (candidates.length) {
      const { error: upsertError } = await supabase
        .from("tracer_core_candidates")
        .upsert(candidates, { onConflict: "canonical_key" });
      if (upsertError) throw new Error(upsertError.message);
    }

    const qualified = candidates.filter((c) => c.state === "QUALIFIED").length;
    const { error: finishError } = await supabase
      .from("tracer_core_runs")
      .update({
        status: "succeeded",
        processed: data?.length ?? 0,
        discovered: candidates.length,
        qualified,
        rejected: candidates.length - qualified,
        finished_at: new Date().toISOString(),
        metrics: { sourceRows: data?.length ?? 0, uniqueCandidates: candidates.length },
      })
      .eq("id", run.id);
    if (finishError) throw new Error(finishError.message);

    return NextResponse.json({ ok: true, processed: data?.length ?? 0, candidates: candidates.length, qualified });
  } catch (error) {
    await supabase.from("tracer_core_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: 1,
      metrics: { error: error instanceof Error ? error.message : String(error) },
    }).eq("id", run.id);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
