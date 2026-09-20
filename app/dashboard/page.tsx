import { ConnectionPanel } from "@/components/connection-panel";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import { getFoundationStatus } from "@/lib/config/env";
import { getOpportunityKpis } from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const status = getFoundationStatus();

  let kpis = null;
  let error: string | null = null;

  try {
    kpis = await getOpportunityKpis();
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? null
        : caught instanceof Error
          ? caught.message
          : "KPI を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Dashboard
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">運用ダッシュボード</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        商品数ではなく、販売テストまで進んだ商機を見ます。実測がない指標は unknown です。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {kpis ? (
        <div className="mt-10">
          <OpportunityKpis kpis={kpis} />
        </div>
      ) : null}
      <div className="mt-10 max-w-xl">
        <ConnectionPanel status={status} />
      </div>
    </main>
  );
}
