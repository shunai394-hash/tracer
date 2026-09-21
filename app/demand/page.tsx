import Link from "next/link";
import { listDemandIntelligence } from "@/lib/intelligence/demand-store";
import {
  demandStabilityLabel,
  demandTrendLabel,
} from "@/lib/intelligence/analyze-demand";
import {
  formatConfidence,
  formatScore,
} from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function pct(value: number | null): string {
  if (value === null) return "unknown";
  return `${Math.round(value * 100)}%`;
}

export default async function DemandPage() {
  let rows: Awaited<ReturnType<typeof listDemandIntelligence>> = [];
  let error: string | null = null;

  try {
    rows = await listDemandIntelligence();
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? "Supabase が未設定のため Demand を読めません。"
        : caught instanceof Error
          ? caught.message
          : "Demand を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Demand Intelligence
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">需要分析</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        検索数だけではなく、速度・急騰・継続性を実観測から見ます。未観測の SNS や順位は
        unknown です。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {rows.length === 0 && !error ? (
        <div className="mt-10 border border-dashed border-cyan-500/20 p-10 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">
            No demand series yet
          </p>
          <p className="mt-3 text-sm text-zinc-400">
            Google Trends の観測が複数回溜まると、速度とトレンドを計算します。
          </p>
        </div>
      ) : (
        <div className="mt-10 divide-y divide-white/5 border border-cyan-500/15">
          {rows.map((row) => (
            <article key={row.id} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-lg text-zinc-50">
                  <Link href={`/demand/${row.id}`} className="hover:text-cyan-200">
                    {row.query}
                  </Link>
                </h2>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                  Score {formatScore(row.demandScore)} ·{" "}
                  {demandTrendLabel(row.trend)} · Confidence{" "}
                  {formatConfidence(row.demandConfidence)}
                </p>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-zinc-300 sm:grid-cols-3">
                <p>Volume {row.volume ?? "unknown"}</p>
                <p>Velocity 7d {pct(row.velocity7d)}</p>
                <p>Stability {demandStabilityLabel(row.stability)}</p>
              </div>
              {row.series.length > 1 ? (
                <p className="mt-2 font-mono text-[11px] text-zinc-500">
                  {row.series
                    .slice(-6)
                    .map((point) => point.value)
                    .join(" → ")}
                </p>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">
                  推移を判断できる観測点が足りません。
                </p>
              )}
              {row.spike ? (
                <p className="mt-2 text-xs text-amber-300">
                  急騰を検出。継続成長とは断定していません。
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
