import Link from "next/link";
import { listDemandIntelligence } from "@/lib/intelligence/demand-store";
import { demandStabilityLabel, demandTrendLabel } from "@/lib/intelligence/analyze-demand";
import { formatConfidence, formatScore } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
function pct(value: number | null): string { return value === null ? "unknown" : String(Math.round(value * 100)) + "%"; }

export default async function DemandPage() {
  let rows: Awaited<ReturnType<typeof listDemandIntelligence>> = [];
  let error: string | null = null;
  try { rows = await listDemandIntelligence(); }
  catch (caught) { error = caught instanceof SupabaseConfigError ? "Supabase が未設定のため Demand を読めません。" : caught instanceof Error ? caught.message : "Demand を読み込めませんでした。"; }

  return (
    <main className="tracer-editorial-page">
      <header className="tracer-editorial-hero tracer-demand-hero">
        <div className="tracer-editorial-index"><span>04</span><span>OBSERVE / DEMAND</span><span>TIME SERIES</span></div>
        <div className="tracer-editorial-hero-grid">
          <div><p className="tracer-kicker">Demand Intelligence</p><h1>需要の「今」を、<br /><em>速度と継続</em>で読む。</h1><p className="tracer-lede">検索数だけではなく、速度・急騰・継続性を実観測から見る。観測できないSNSや順位は、unknownのまま。</p></div>
          <aside className="tracer-editorial-note"><span>METHOD / TIME SERIES</span><strong>一度の急騰を、<br />成長とは呼ばない。</strong><p>複数の観測点が揃って、はじめて変化を読む。</p></aside>
        </div>
        <div className="tracer-editorial-scan"><span>VOLUME</span><span>VELOCITY</span><span>STABILITY</span><span>CONFIDENCE</span></div>
      </header>
      {error ? <p role="alert" className="tracer-alert">{error}</p> : rows.length === 0 ? <div className="tracer-empty"><span>NO DEMAND SERIES YET</span><h2>需要の時系列を集めています。</h2><p>Google Trends の観測が複数回溜まると、速度とトレンドを計算します。</p></div> : <section className="tracer-demand-list" aria-label="Demand intelligence">
        {rows.map((row, index) => <article key={row.id} className="tracer-demand-row">
          <span className="tracer-demand-index">{String(index + 1).padStart(2,"0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-3"><h2><Link href={"/demand/" + row.id}>{row.query}</Link></h2><p>Score {formatScore(row.demandScore)} · {demandTrendLabel(row.trend)} · Confidence {formatConfidence(row.demandConfidence)}</p></div>
            <div className="tracer-demand-metrics"><span>VOLUME <b>{row.volume ?? "unknown"}</b></span><span>VELOCITY 7D <b>{pct(row.velocity7d)}</b></span><span>STABILITY <b>{demandStabilityLabel(row.stability)}</b></span></div>
            <div className="tracer-sparkline" aria-label="Recent demand values">{row.series.length > 1 ? row.series.slice(-8).map((point, i) => <span key={String(point.value) + "-" + i} style={{height: String(Math.max(8, Math.min(100, point.value))) + "%"}} />) : <span className="unknown" />}</div>
            {row.spike ? <p className="tracer-spike">SPIKE DETECTED / 継続成長とは断定していません。</p> : null}
          </div>
        </article>)}
      </section>}
    </main>
  );
}
