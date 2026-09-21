import Link from "next/link";
import { notFound } from "next/navigation";
import { getDemandIntelligence } from "@/lib/intelligence/demand-store";
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

function seriesForDays(
  series: Array<{ observedAt: string; value: number }>,
  days: number,
) {
  if (series.length === 0) return [];
  const latest = new Date(series[series.length - 1].observedAt).getTime();
  return series.filter(
    (point) => latest - new Date(point.observedAt).getTime() <= days * 86_400_000,
  );
}

export default async function DemandDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    const demand = await getDemandIntelligence(id);
    if (!demand) notFound();

    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
        <Link
          href="/demand"
          className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400 hover:text-cyan-200"
        >
          ← Demand
        </Link>
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
          WHAT / WHY / NOW / VELOCITY
        </p>
        <h1 className="mt-3 text-3xl text-zinc-50">{demand.query}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
          需要量だけでなく、変化速度と継続性を観測点から計算しています。
        </p>

        <section className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            ["Demand Score", formatScore(demand.demandScore)],
            ["Trend", demandTrendLabel(demand.trend)],
            ["Stability", demandStabilityLabel(demand.stability)],
            ["Volume", demand.volume === null ? "unknown" : String(demand.volume)],
            ["Velocity 7d", pct(demand.velocity7d)],
            ["Velocity 14d", pct(demand.velocity14d)],
            ["Velocity 30d", pct(demand.velocity30d)],
            ["Confidence", formatConfidence(demand.demandConfidence)],
            ["SNS", demand.socialMentions === null ? "unknown" : String(demand.socialMentions)],
          ].map(([label, value]) => (
            <article key={label} className="border border-cyan-500/15 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                {label}
              </p>
              <p className="mt-2 text-xl text-zinc-100">{value}</p>
            </article>
          ))}
        </section>

        {demand.spike ? (
          <p className="mt-6 text-sm text-amber-300">
            急騰を検出しています。一度の増加なので、継続上昇とは区別しています。
          </p>
        ) : null}

        <section className="mt-10 border border-cyan-500/15 p-5">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
            Series
          </h2>
          {(
            [
              { label: "7日", points: seriesForDays(demand.series, 7) },
              { label: "14日", points: seriesForDays(demand.series, 14) },
              { label: "30日", points: seriesForDays(demand.series, 30) },
            ] as const
          ).map(({ label, points }) => {
            const series = points;
            return (
              <div key={label} className="mt-4">
                <p className="text-sm text-zinc-300">{label}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500">
                  {series.length > 0
                    ? series.map((point) => point.value).join(" → ")
                    : "unknown"}
                </p>
              </div>
            );
          })}
        </section>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/intelligence"
            className="border border-cyan-400/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200"
          >
            商品へつなぐ
          </Link>
          <Link
            href="/chat"
            className="border border-cyan-400/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200"
          >
            AIに聞く
          </Link>
        </div>
      </main>
    );
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
          <p className="text-sm text-amber-300">
            Supabase が未設定のため Demand を読めません。
          </p>
        </main>
      );
    }
    throw error;
  }
}
