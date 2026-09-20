import Link from "next/link";
import type { OpportunityListItem } from "@/lib/intelligence/opportunity-store";
import {
  formatConfidenceLabel,
  formatMoney,
  formatScore,
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
    <div className="border border-white/5 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </p>
      <p className="mt-1 text-xl text-zinc-100">{formatScore(value)}</p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-400/80">
        Confidence: {formatConfidenceLabel(confidence)}
      </p>
      {value === null ? (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-400/80">
          unknown
        </p>
      ) : null}
      {evidence ? (
        <p className="mt-1 text-[11px] leading-5 text-zinc-500">{evidence}</p>
      ) : null}
    </div>
  );
}

function evidenceLine(
  evidence: unknown[],
  id: string,
): string | undefined {
  const item = evidence.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { id?: string }).id === id;
  }) as
    | {
        source?: string;
        observedAt?: string | null;
        value?: unknown;
        metric?: string;
      }
    | undefined;

  if (!item) return undefined;

  const parts = [
    item.source,
    item.metric,
    item.value === null || item.value === undefined ? null : String(item.value),
    item.observedAt ? `Observed: ${item.observedAt.slice(0, 10)}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : undefined;
}

export function OpportunityCard({
  opportunity,
}: {
  opportunity: OpportunityListItem;
}) {
  const demandEvidence = evidenceLine(opportunity.evidence, "demand");
  const priceEvidence = evidenceLine(opportunity.evidence, "market_price");

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
            TEST PRIORITY · {opportunity.lifecycleStatus} · {opportunity.sellabilityState}
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
            Opportunity score {formatScore(opportunity.opportunityScore)} · overall
            confidence {formatConfidenceLabel(opportunity.confidenceLabels.overall)}
          </p>
          {opportunity.judgment ? (
            <p className="mt-2 text-sm text-zinc-300">{opportunity.judgment}</p>
          ) : null}
        </div>
      </div>

      {opportunity.missing.length > 0 ? (
        <div className="mt-4 border border-amber-400/20 bg-amber-400/5 px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber-300">
            NEEDS_DATA
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-100/80">
            {opportunity.missing.join(" · ")}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-3 gap-2">
        <ScoreCell
          label="Demand"
          value={opportunity.demandScore}
          confidence={opportunity.confidenceLabels.demand}
          evidence={demandEvidence}
        />
        <ScoreCell
          label="Profit"
          value={opportunity.profitScore}
          confidence={opportunity.confidenceLabels.price}
          evidence={priceEvidence}
        />
        <ScoreCell
          label="Timing"
          value={opportunity.timingScore}
          confidence={opportunity.confidenceLabels.overall}
        />
      </div>

      <section className="mt-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          Why now
        </p>
        {opportunity.whyNow.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm leading-6 text-zinc-300">
            {opportunity.whyNow.map((item) => (
              <li key={`${item.field}-${item.statement}`}>
                ・{item.statement}
                {item.source ? ` / ${item.source}` : ""}
                {item.observedAt ? ` / ${item.observedAt.slice(0, 10)}` : ""}
              </li>
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
            Estimated profit
          </p>
          {opportunity.profitCalculable ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-300">
              <li>
                観測市場価格{" "}
                {formatMoney(opportunity.marketPrice, opportunity.marketCurrency)}
              </li>
              <li>
                仕入れ {formatMoney(opportunity.sourceCost, opportunity.sourceCurrency)}
              </li>
              <li>
                推定粗利{" "}
                {formatMoney(
                  opportunity.estimatedContributionProfit ??
                    opportunity.contributionProfit,
                  opportunity.marketCurrency,
                )}
              </li>
              <li>
                実測粗利{" "}
                {opportunity.actualContributionProfit === null
                  ? "unknown"
                  : formatMoney(
                      opportunity.actualContributionProfit,
                      opportunity.marketCurrency,
                    )}
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-amber-300/90">利益計算不能</p>
          )}
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Risk / unknown
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
          Dimension confidence
        </summary>
        <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-4">
          {Object.entries(opportunity.confidenceLabels).map(([key, value]) => (
            <p key={key}>
              {key}: {formatConfidenceLabel(value)}
            </p>
          ))}
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
