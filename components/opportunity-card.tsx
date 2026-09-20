import Link from "next/link";
import type { OpportunityListItem } from "@/lib/intelligence/opportunity-store";
import {
  formatMoney,
  formatScore,
} from "@/lib/intelligence/format-display";
import { StartTestButton } from "@/components/start-test-button";

function ScoreCell({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div className="border border-white/5 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </p>
      <p className="mt-1 text-xl text-zinc-100">{formatScore(value)}</p>
      {value === null ? (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-400/80">
          unknown
        </p>
      ) : null}
    </div>
  );
}

export function OpportunityCard({
  opportunity,
}: {
  opportunity: OpportunityListItem;
}) {
  const metadata = opportunity.metadata;
  const demandDetail = {
    searchGrowth: metadata.search_growth,
    socialSignal: metadata.social_signal,
    reviewVelocity: metadata.review_velocity,
    sourceCount: metadata.source_count,
    freshness: metadata.observation_freshness_hours,
  };

  return (
    <article className="border border-cyan-500/15 bg-zinc-950/70 p-5">
      <div className="flex gap-4">
        {opportunity.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={opportunity.imageUrl}
            alt={opportunity.productName}
            className="h-24 w-24 shrink-0 object-cover"
          />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center border border-dashed border-cyan-500/20 text-[10px] uppercase tracking-[0.18em] text-zinc-600">
            No image
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400/80">
            {opportunity.sellabilityState}
          </p>
          <h2 className="mt-1 truncate text-lg text-zinc-50">
            <Link
              href={`/intelligence/${opportunity.id}`}
              className="hover:text-cyan-200"
            >
              {opportunity.productName}
            </Link>
          </h2>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">
            テスト優先度 / confidence {opportunity.overallConfidence === null ? "unknown" : `${Math.round(opportunity.overallConfidence * 100)}%`}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <ScoreCell label="Demand" value={opportunity.demandScore} />
        <ScoreCell label="Profit" value={opportunity.profitScore} />
        <ScoreCell label="Timing" value={opportunity.timingScore} />
      </div>

      <section className="mt-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          Why now
        </p>
        {opportunity.whyNow.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm leading-6 text-zinc-300">
            {opportunity.whyNow.map((item) => (
              <li key={`${item.field}-${item.statement}`}>・{item.statement}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">
            実データから言える「今やる理由」はまだありません。
          </p>
        )}
      </section>

      <section className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Profit
          </p>
          {opportunity.profitCalculable ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-300">
              <li>販売価格 {formatMoney(opportunity.marketPrice, opportunity.marketCurrency)}</li>
              <li>仕入れ {formatMoney(opportunity.sourceCost, opportunity.sourceCurrency)}</li>
              <li>
                想定粗利 {formatMoney(opportunity.contributionProfit, opportunity.marketCurrency)}
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-amber-300/90">利益計算不能</p>
          )}
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Risk
          </p>
          {opportunity.risks.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-400">
              {opportunity.risks.map((risk) => (
                <li key={risk.code}>・{risk.message}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">観測されたリスクはありません。</p>
          )}
        </div>
      </section>

      <details className="mt-5 border-t border-white/5 pt-4">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          Demand / Profit / Timing の根拠
        </summary>
        <div className="mt-3 grid gap-3 text-xs leading-6 text-zinc-400 sm:grid-cols-3">
          <div>
            <p className="text-zinc-200">Demand</p>
            <p>search growth: {String(demandDetail.searchGrowth ?? "unknown")}</p>
            <p>social signal: {String(demandDetail.socialSignal ?? "unknown")}</p>
            <p>review velocity: {String(demandDetail.reviewVelocity ?? "unknown")}</p>
            <p>source count: {String(demandDetail.sourceCount ?? "unknown")}</p>
            <p>freshness hours: {String(demandDetail.freshness ?? "unknown")}</p>
          </div>
          <div>
            <p className="text-zinc-200">Profit</p>
            <p>market price: {formatMoney(opportunity.marketPrice, opportunity.marketCurrency)}</p>
            <p>source cost: {formatMoney(opportunity.sourceCost, opportunity.sourceCurrency)}</p>
            <p>currency: {opportunity.currencyConfidence ?? "unknown"}</p>
            <p>
              contribution: {opportunity.profitCalculable
                ? formatMoney(opportunity.contributionProfit, opportunity.marketCurrency)
                : "計算不能"}
            </p>
          </div>
          <div>
            <p className="text-zinc-200">Timing</p>
            <p>state: {opportunity.sellabilityState}</p>
            <p>test status: {opportunity.latestTestStatus ?? "none"}</p>
          </div>
        </div>
      </details>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          Next action
        </p>
        <StartTestButton
          opportunityId={opportunity.id}
          enabled={opportunity.sellabilityState === "TEST_READY"}
        />
      </div>
    </article>
  );
}
