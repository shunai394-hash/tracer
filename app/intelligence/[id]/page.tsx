import Link from "next/link";
import { notFound } from "next/navigation";
import { OpportunityCard } from "@/components/opportunity-card";
import { getOpportunity } from "@/lib/intelligence/opportunity-store";
import { formatConfidence, formatScore } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    const opportunity = await getOpportunity(id);

    if (!opportunity) {
      notFound();
    }

    const metadata = opportunity.metadata;
    const provenance = Array.isArray(metadata.provenance)
      ? metadata.provenance
      : [];
    const profitLines = Array.isArray(metadata.profit_lines)
      ? metadata.profit_lines
      : [];
    const missing = Array.isArray(metadata.missing) ? metadata.missing : [];

    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
        <Link
          href="/intelligence"
          className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400 hover:text-cyan-200"
        >
          ← Opportunities
        </Link>
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
          Why test this now
        </p>
        <h1 className="mt-3 text-3xl text-zinc-50">{opportunity.productName}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
          この画面は推定と実測を混ぜません。足りないデータは unknown のまま残します。
        </p>

        <div className="mt-10">
          <OpportunityCard opportunity={opportunity} />
        </div>

        <section className="mt-10 grid gap-6 lg:grid-cols-2">
          <article className="border border-cyan-500/15 p-5">
            <h2 className="text-lg text-zinc-100">Sellability</h2>
            <p className="mt-2 font-mono text-xs uppercase tracking-[0.18em] text-cyan-300">
              {opportunity.sellabilityState}
            </p>
            <p className="mt-3 text-sm text-zinc-400">
              不足: {missing.length > 0 ? missing.join(", ") : "なし"}
            </p>
            <p className="mt-2 text-sm text-zinc-400">
              Opportunity score: {formatScore(opportunity.opportunityScore)} /
              confidence {formatConfidence(opportunity.overallConfidence)}
            </p>
          </article>
          <article className="border border-cyan-500/15 p-5">
            <h2 className="text-lg text-zinc-100">Profit lines</h2>
            {profitLines.length > 0 ? (
              <ul className="mt-3 space-y-1 text-sm text-zinc-400">
                {profitLines.map((line) => {
                  const item = line as {
                    key?: string;
                    label?: string;
                    amount?: number | null;
                    kind?: string;
                  };
                  return (
                    <li key={item.key ?? item.label}>
                      {item.label}: {item.amount ?? "unknown"} ({item.kind})
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-amber-300">利益計算不能</p>
            )}
          </article>
        </section>

        <section className="mt-8 border border-cyan-500/15 p-5">
          <h2 className="text-lg text-zinc-100">Provenance</h2>
          {provenance.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm leading-6 text-zinc-400">
              {provenance.map((entry, index) => {
                const item = entry as {
                  field?: string;
                  kind?: string;
                  source?: string;
                  note?: string;
                };
                return (
                  <li key={`${item.field}-${index}`}>
                    {item.field} / {item.kind} / {item.source}
                    {item.note ? ` / ${item.note}` : ""}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">根拠はまだありません。</p>
          )}
        </section>
      </main>
    );
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return (
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
          <p className="text-sm text-amber-300">
            Supabase が未設定のため Opportunity を読めません。
          </p>
        </main>
      );
    }

    throw error;
  }
}
