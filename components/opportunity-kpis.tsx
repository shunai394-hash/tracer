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

export function OpportunityKpis({ kpis }: { kpis: OpportunityKpis }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label="Opportunity count" value={String(kpis.opportunityCount)} />
      <Kpi label="TEST_READY" value={String(kpis.testReadyCount)} />
      <Kpi label="Test started" value={String(kpis.testStarted)} />
      <Kpi
        label="Orders"
        value={kpis.orders === null ? "unknown" : String(kpis.orders)}
      />
      <Kpi
        label="Revenue"
        value={kpis.revenue === null ? "unknown" : String(kpis.revenue)}
      />
      <Kpi
        label="Contribution profit"
        value={
          kpis.contributionProfit === null
            ? "unknown"
            : String(kpis.contributionProfit)
        }
      />
      <Kpi
        label="Winner candidates"
        value={String(kpis.winnerCandidates)}
      />
      <Kpi
        label="Time to test"
        value={
          kpis.timeToTestHours === null
            ? "unknown"
            : `${kpis.timeToTestHours}h`
        }
      />
    </section>
  );
}
