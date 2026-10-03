import Link from "next/link";
import type { OpportunityListItem } from "@/lib/intelligence/opportunity-store";
import {
  formatConfidence,
  formatConfidenceLabel,
  formatMoney,
  formatScore,
  formatUnits,
} from "@/lib/intelligence/format-display";
import { StartTestButton } from "@/components/start-test-button";

function ScoreCell({
  label,
  value,
  confidence,
  evidence,
}: {
  label: string;
  value: number | null;
  confidence: string;
  evidence?: string;
}) {
  return (
    <div className="border border-white/5 bg-black/10 px-3 py-3">
      <p className="text-[10px] font-medium tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 text-xl tracking-tight text-zinc-100">{formatScore(value)}</p>
      <p className="mt-1 text-[10px] text-cyan-400/80">確かさ: {formatConfidenceLabel(confidence)}</p>
      {value === null ? <p className="mt-1 text-[10px] text-amber-400/80">未確認</p> : null}
      {evidence ? <p className="mt-1 text-[11px] leading-5 text-zinc-500">{evidence}</p> : null}
    </div>
  );
}

function evidenceLine(evidence: unknown[], id: string): string | undefined {
  const item = evidence.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { id?: string }).id === id;
  }) as
    | { source?: string; observedAt?: string | null; value?: unknown; metric?: string }
    | undefined;

  if (!item) return undefined;
  const parts = [
    item.source,
    item.metric,
    item.value === null || item.value === undefined ? null : String(item.value),
    item.observedAt ? `確認日 ${item.observedAt.slice(0, 10)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

export function OpportunityCard({ opportunity }: { opportunity: OpportunityListItem }) {
  const demandEvidence = evidenceLine(opportunity.evidence, "demand");
  const priceEvidence = evidenceLine(opportunity.evidence, "market_price");

  return (
    <article className="overflow-hidden border border-cyan-500/15 bg-zinc-950/70">
      <div className="p-5 sm:p-6">
        <div className="flex gap-4">
          {opportunity.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={opportunity.imageUrl} alt={opportunity.productName} className="h-24 w-24 shrink-0 object-cover sm:h-28 sm:w-28" />
          ) : (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center border border-dashed border-cyan-500/20 text-[10px] tracking-[0.12em] text-zinc-600 sm:h-28 sm:w-28">
              画像未確認
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium tracking-[0.16em] text-cyan-400/80">選定候補</p>
            <h2 className="mt-1 text-xl tracking-tight text-zinc-50 sm:text-2xl">
              <Link href={`/intelligence/${opportunity.id}`} className="transition hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                {opportunity.productName}
              </Link>
            </h2>
            <p className="mt-2 text-xs text-zinc-500">
              選定スコア {formatScore(opportunity.selectionScore)} · 総合的な確かさ {formatConfidenceLabel(opportunity.confidenceLabels.overall)}
            </p>
            {opportunity.judgment ? <p className="mt-3 text-sm leading-6 text-zinc-300">{opportunity.judgment}</p> : null}
          </div>
        </div>

        {opportunity.missing.length > 0 ? (
          <div className="mt-5 border border-amber-400/20 bg-amber-400/5 px-4 py-3">
            <p className="text-[10px] font-medium tracking-[0.14em] text-amber-300">まだ確認が必要なこと</p>
            <p className="mt-1 text-xs leading-5 text-amber-100/80">{opportunity.missing.join(" · ")}</p>
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ScoreCell label="需要" value={opportunity.demandScore} confidence={opportunity.confidenceLabels.demand} evidence={demandEvidence} />
          <ScoreCell label="利益の見込み" value={opportunity.profitScore} confidence={opportunity.confidenceLabels.price} evidence={priceEvidence} />
          <ScoreCell label="検索との相性" value={opportunity.searchFitScore} confidence={opportunity.searchFitScore === null ? "unknown" : opportunity.confidenceLabels.overall} />
          <ScoreCell label="市場とのすき間" value={opportunity.marketGapScore} confidence={opportunity.marketGapScore === null ? "unknown" : opportunity.confidenceLabels.competition} />
          <ScoreCell label="タイミング" value={opportunity.timingScore} confidence={opportunity.confidenceLabels.overall} />
          <ScoreCell label="選定" value={opportunity.selectionScore} confidence={opportunity.selectionEligible === false ? "low" : opportunity.confidenceLabels.overall} evidence={opportunity.selectionEligible === false ? "現在は選定対象外" : opportunity.selectionEligible === true ? "現在の選定対象" : undefined} />
        </div>

        <section className="mt-6 border-t border-white/6 pt-5">
          <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">この商品が候補になった理由</p>
          {opportunity.recommendationSummary ? <p className="mt-2 text-sm leading-6 text-zinc-300">{opportunity.recommendationSummary}</p> : null}
          {opportunity.recommendationReasons.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm leading-6 text-zinc-300">
              {opportunity.recommendationReasons.map((reason) => <li key={reason.code}>・{reason.statement}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">実データから言える推薦理由はまだありません。</p>
          )}
        </section>

        <section className="mt-6 grid gap-6 border-t border-white/6 pt-5 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">AIによる販売予測</p>
            <ul className="mt-2 space-y-1 text-sm text-zinc-300">
              <li>7日 {formatUnits(opportunity.forecastUnits7d)}</li>
              <li>30日 {formatUnits(opportunity.forecastUnits30d)}{opportunity.forecastUnits30dLow !== null && opportunity.forecastUnits30dHigh !== null ? `（${formatUnits(opportunity.forecastUnits30dLow)}–${formatUnits(opportunity.forecastUnits30dHigh)}）` : ""}</li>
              <li>90日 {formatUnits(opportunity.forecastUnits90d)}</li>
              <li>予測売上 {formatMoney(opportunity.forecastRevenue30d, opportunity.marketCurrency)}</li>
              <li>予測粗利 {formatMoney(opportunity.forecastProfit30d, opportunity.marketCurrency)}</li>
              <li>予測の確かさ {formatConfidence(opportunity.forecastConfidence)}{opportunity.forecastKind ? ` / ${opportunity.forecastKind}` : ""}</li>
              <li>予測誤差 {opportunity.forecastErrorUnits30d === null ? "未確認" : `${opportunity.forecastErrorUnits30d}個`}</li>
            </ul>
          </div>
          <div>
            <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">いま見る理由</p>
            {opportunity.whyNow.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm leading-6 text-zinc-300">
                {opportunity.whyNow.map((item) => <li key={`${item.field}-${item.statement}`}>・{item.statement}{item.source ? ` / ${item.source}` : ""}{item.observedAt ? ` / ${item.observedAt.slice(0, 10)}` : ""}</li>)}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">実データから言える「今見る理由」はまだありません。</p>
            )}
          </div>
        </section>

        <section className="mt-6 grid gap-6 border-t border-white/6 pt-5 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">利益の確認</p>
            {opportunity.profitCalculable ? (
              <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                <li>観測市場価格 {formatMoney(opportunity.marketPrice, opportunity.marketCurrency)}</li>
                <li>仕入れ {formatMoney(opportunity.sourceCost, opportunity.sourceCurrency)}</li>
                <li>推定粗利 {formatMoney(opportunity.estimatedContributionProfit ?? opportunity.contributionProfit, opportunity.marketCurrency)}</li>
                <li>実測粗利 {opportunity.actualContributionProfit === null ? "未確認" : formatMoney(opportunity.actualContributionProfit, opportunity.marketCurrency)}</li>
              </ul>
            ) : <p className="mt-2 text-sm text-amber-300/90">まだ利益を計算できません。</p>}
          </div>
          <div>
            <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">注意点</p>
            {opportunity.risks.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-zinc-400">
                {opportunity.risks.map((risk) => <li key={risk.code}>・{risk.message}</li>)}
              </ul>
            ) : <p className="mt-2 text-sm text-zinc-500">現在、観測された注意点はありません。</p>}
          </div>
        </section>

        <details className="mt-6 border-t border-white/6 pt-4">
          <summary className="cursor-pointer text-[10px] font-medium tracking-[0.14em] text-zinc-500">データの確かさを見る</summary>
          <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-4">
            {Object.entries(opportunity.confidenceLabels).map(([key, value]) => <p key={key}>{key}: {formatConfidenceLabel(value)}</p>)}
          </div>
        </details>

        <section className="mt-6 border border-cyan-500/15 bg-black/30 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-500">販売テストの条件</p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">
                {opportunity.sellabilityState === "TEST_READY"
                  ? "必要な確認が揃っています。販売テストへ進めます。"
                  : opportunity.missing.length > 0
                    ? "公開前に、まだ確認が必要な情報があります。"
                    : "現在は販売テストの条件を満たしていません。詳細で状態を確認できます。"}
              </p>
            </div>
            <Link href={`/intelligence/${opportunity.id}`} className="text-xs font-medium text-cyan-300 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
              詳しい確認を見る →
            </Link>
          </div>
          {opportunity.sellabilityState !== "TEST_READY" && opportunity.missing.length > 0 ? (
            <ul className="mt-3 grid gap-1 text-xs text-amber-200/80 sm:grid-cols-2">
              {opportunity.missing.map((item) => <li key={item}>・{item}</li>)}
            </ul>
          ) : null}
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-[10px] text-zinc-600">{opportunity.sellabilityState === "TEST_READY" ? "販売テスト可能" : "確認中"}</p>
            <StartTestButton opportunityId={opportunity.id} enabled={opportunity.sellabilityState === "TEST_READY"} />
          </div>
        </section>
      </div>
    </article>
  );
}
