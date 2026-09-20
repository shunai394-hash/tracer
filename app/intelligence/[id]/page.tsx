import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpportunityCard } from "@/components/opportunity-card";
import { RecordResultsForm } from "@/components/record-results-form";
import { getOpportunity } from "@/lib/intelligence/opportunity-store";
import {
  formatConfidenceLabel,
  formatMoney,
  formatScore,
} from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="border border-cyan-500/15 p-5">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-6 text-zinc-300">{children}</div>
    </article>
  );
}

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

    const provenance = Array.isArray(opportunity.metadata.provenance)
      ? opportunity.metadata.provenance
      : [];
    const latestTest = opportunity.tests[0] ?? null;
    const measured = opportunity.metadata.measured as
      | Record<string, unknown>
      | null
      | undefined;

    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
        <Link
          href="/intelligence"
          className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400 hover:text-cyan-200"
        >
          ← Opportunities
        </Link>
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
          TEST PRIORITY
        </p>
        <h1 className="mt-3 text-3xl text-zinc-50">{opportunity.productName}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
          推定と実測は混ぜません。足りないデータは unknown のまま残します。
        </p>

        <div className="mt-10">
          <OpportunityCard opportunity={opportunity} />
        </div>

        <section className="mt-10 grid gap-6 lg:grid-cols-2">
          <Panel title="WHAT">
            <p>{opportunity.productName}</p>
            <p className="text-zinc-500">
              Lifecycle {opportunity.lifecycleStatus} / sellability{" "}
              {opportunity.sellabilityState}
            </p>
          </Panel>
          <Panel title="WHY">
            {opportunity.judgment ? (
              <p>{opportunity.judgment}</p>
            ) : (
              <p>実データから言える判断文はまだありません。</p>
            )}
            <p className="mt-2 text-zinc-500">
              Opportunity score {formatScore(opportunity.opportunityScore)} は販売テスト優先度であり、勝ち確定ではありません。
            </p>
          </Panel>
          <Panel title="WHY NOW">
            {opportunity.whyNow.length > 0 ? (
              <ul className="space-y-1">
                {opportunity.whyNow.map((item) => (
                  <li key={`${item.field}-${item.statement}`}>
                    {item.statement}
                    {item.source ? ` / ${item.source}` : ""}
                    {item.observedAt ? ` / ${item.observedAt.slice(0, 10)}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p>根拠のある WHY NOW はありません。</p>
            )}
          </Panel>
          <Panel title="CAN WE SELL">
            <p>{opportunity.sellabilityState}</p>
            <p>
              Supply confidence:{" "}
              {formatConfidenceLabel(opportunity.confidenceLabels.supply)}
            </p>
            <p>
              Identity confidence:{" "}
              {formatConfidenceLabel(opportunity.confidenceLabels.identity)}
            </p>
          </Panel>
          <Panel title="CAN WE PROFIT">
            {opportunity.profitCalculable ? (
              <ul>
                <li>
                  Estimated:{" "}
                  {formatMoney(
                    opportunity.estimatedContributionProfit,
                    opportunity.marketCurrency,
                  )}
                </li>
                <li>
                  Actual:{" "}
                  {opportunity.actualContributionProfit === null
                    ? "unknown"
                    : formatMoney(
                        opportunity.actualContributionProfit,
                        opportunity.marketCurrency,
                      )}
                </li>
              </ul>
            ) : (
              <p>利益計算不能 / currency or price data is not reliable</p>
            )}
          </Panel>
          <Panel title="WHAT IS UNKNOWN">
            {opportunity.missing.length > 0 ? (
              <p>{opportunity.missing.join(", ")}</p>
            ) : (
              <p>必須データの欠落はありません。未知の競合広告などは unknown のままです。</p>
            )}
            <p className="mt-2 text-zinc-500">
              Competition count: {opportunity.competitorCount ?? "unknown"} ·
              ad presence: unknown unless observed
            </p>
          </Panel>
          <Panel title="WHAT SHOULD WE TEST">
            {latestTest ? (
              <ul>
                <li>Test ID: {latestTest.id}</li>
                <li>Stage: {latestTest.experimentStage ?? "hypothesis"}</li>
                <li>Hypothesis: {latestTest.hypothesis ?? "unknown"}</li>
                <li>
                  Test price:{" "}
                  {latestTest.testPrice === null ? "unknown" : latestTest.testPrice}
                </li>
              </ul>
            ) : opportunity.sellabilityState === "TEST_READY" ? (
              <p>データ品質ゲートを通過しています。実験として開始できます。</p>
            ) : (
              <p>TEST_READY ではないため、不足データを先に埋める必要があります。</p>
            )}
          </Panel>
          <Panel title="WHAT HAPPENED">
            {measured ? (
              <ul>
                <li>kind: {String(measured.kind ?? "observed")}</li>
                <li>orders: {String(measured.orders ?? "unknown")}</li>
                <li>revenue: {String(measured.revenue ?? "unknown")}</li>
                <li>
                  contribution: {String(measured.contribution_profit ?? "unknown")}
                </li>
              </ul>
            ) : (
              <p>実測結果はまだありません。</p>
            )}
          </Panel>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <Panel title="WHAT DID WE LEARN">
            {opportunity.failures.length > 0 ? (
              <ul className="space-y-1">
                {opportunity.failures.map((failure) => (
                  <li key={failure.id}>
                    {failure.reasonCode}
                    {failure.note ? ` / ${failure.note}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p>失敗学習データはまだありません。</p>
            )}
          </Panel>
          <Panel title="Lifecycle history">
            {opportunity.lifecycleEvents.length > 0 ? (
              <ul className="space-y-1">
                {opportunity.lifecycleEvents.map((event) => (
                  <li key={`${event.toStatus}-${event.createdAt}`}>
                    {event.fromStatus ?? "none"} → {event.toStatus}
                    {event.reason ? ` / ${event.reason}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p>状態変更履歴はまだありません。</p>
            )}
          </Panel>
        </section>

        {latestTest ? (
          <section className="mt-8 border border-cyan-500/15 p-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
              Record actual results
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              入力値は observed / manual として保存します。estimated は上書きしません。
            </p>
            <RecordResultsForm testId={latestTest.id} />
          </section>
        ) : null}

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
                  observedAt?: string | null;
                };
                return (
                  <li key={`${item.field}-${index}`}>
                    {item.field} / {item.kind} / {item.source}
                    {item.observedAt ? ` / ${item.observedAt}` : ""}
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
