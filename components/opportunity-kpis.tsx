import type { OpportunityKpis } from "@/lib/intelligence/opportunity-store";

function Kpi({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="border border-cyan-500/15 bg-black/40 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 text-xl text-zinc-50">{value}</p>
    </div>
  );
}

function formatUnknown(value: number | null, suffix = ""): string {
  if (value === null) return "unknown";
  return `${value}${suffix}`;
}

export function OpportunityKpis({ kpis }: { kpis: OpportunityKpis }) {
  const failureEntries = Object.entries(kpis.failureReasonDistribution);

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Opportunity count" value={String(kpis.opportunityCount)} />
        <Kpi label="TEST_READY" value={String(kpis.testReadyCount)} />
        <Kpi label="Test started" value={String(kpis.testStarted)} />
        <Kpi label="Orders" value={formatUnknown(kpis.orders)} />
        <Kpi label="Revenue" value={formatUnknown(kpis.revenue)} />
        <Kpi
          label="Actual contribution profit"
          value={formatUnknown(kpis.contributionProfit)}
        />
        <Kpi
          label="Observed profitable tests"
          value={String(kpis.winnerCandidates)}
        />
        <Kpi
          label="Time to test"
          value={formatUnknown(kpis.timeToTestHours, "h")}
        />
        <Kpi
          label="Test → order conversion"
          value={formatUnknown(kpis.testToOrderConversion)}
        />
        <Kpi
          label="Test success rate"
          value={formatUnknown(kpis.testSuccessRate)}
        />
        <Kpi
          label="Estimated vs actual profit"
          value={formatUnknown(kpis.estimatedVsActualProfitVariance)}
        />
        <Kpi
          label="Discovery → TEST_READY"
          value={formatUnknown(kpis.timeDiscoveryToReadyHours, "h")}
        />
        <Kpi
          label="TEST_READY → test"
          value={formatUnknown(kpis.timeReadyToTestHours, "h")}
        />
      </div>
      {failureEntries.length > 0 ? (
        <div className="border border-cyan-500/15 bg-black/40 px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Failure reason distribution
          </p>
          <ul className="mt-2 space-y-1 text-sm text-zinc-300">
            {failureEntries.map(([code, count]) => (
              <li key={code}>
                {code}: {count}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-600">
          Failure learning: unknown
        </p>
      )}
    </section>
  );
}
