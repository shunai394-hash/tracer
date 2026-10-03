import { IntelligencePingButton } from "@/components/intelligence-ping-button";
import { OpportunityCard } from "@/components/opportunity-card";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import {
  getOpportunityKpis,
  listOpportunities,
} from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function IntelligencePage() {
  let error: string | null = null;
  let opportunities: Awaited<ReturnType<typeof listOpportunities>> = [];
  let kpis: Awaited<ReturnType<typeof getOpportunityKpis>> | null = null;

  try {
    [opportunities, kpis] = await Promise.all([
      listOpportunities(),
      getOpportunityKpis(),
    ]);
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? "商機データを読み込めません。時間をおいてもう一度お試しください。"
        : caught instanceof Error
          ? caught.message
          : "商機を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-12 sm:px-8 lg:px-10 lg:py-16">
      <header className="border-b border-white/8 pb-8">
        <p className="text-[10px] font-mono uppercase tracking-[0.32em] text-cyan-300/80">Discovery</p>
        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_0.55fr] lg:items-end">
          <div>
            <h1 className="text-4xl tracking-[-0.04em] text-zinc-50 sm:text-5xl">次に見る商品を、理由と一緒に。</h1>
            <p className="mt-5 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              需要、商品同一性、市場価格、仕入条件、利益、検索との相性を実データで確認しながら候補を整理します。
              足りない情報は無理に埋めず、「まだ確認が必要」として残します。
            </p>
          </div>
          <div className="border border-cyan-500/15 bg-cyan-500/[0.025] p-5">
            <p className="text-[10px] font-medium tracking-[0.14em] text-cyan-300/80">TRACERの選定ルール</p>
            <p className="mt-2 text-sm leading-6 text-zinc-300">数字が大きいだけで公開しません。商品として確認できる根拠が揃うことを優先します。</p>
          </div>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mt-8 border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">{error}</p>
      ) : (
        <>
          {kpis ? <div className="mt-8"><OpportunityKpis kpis={kpis} /></div> : null}

          <div className="mt-10">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-600">Curated opportunities</p>
                <h2 className="mt-1 text-xl text-zinc-100">いま確認する候補</h2>
              </div>
              <p className="text-xs text-zinc-600">{opportunities.length}件</p>
            </div>

            {opportunities.length > 0 ? (
              <div className="grid gap-5">
                {opportunities.map((opportunity) => (
                  <OpportunityCard key={opportunity.id} opportunity={opportunity} />
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-cyan-500/20 px-6 py-16 text-center">
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-300/70">Next selection in progress</p>
                <h2 className="mt-4 text-2xl tracking-tight text-zinc-100">確認できる商機を探しています。</h2>
                <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-zinc-500">
                  需要・商品・仕入・価格の根拠が揃うまで、候補を無理に増やしません。新しい観測が入るたびに再確認します。
                </p>
              </div>
            )}
          </div>
        </>
      )}

      <section className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-white/6 pt-5">
        <div>
          <p className="text-[10px] font-medium tracking-[0.14em] text-zinc-600">AI品質チェック</p>
          <p className="mt-1 text-xs text-zinc-500">AIの補助が利用できるかを確認できます。公開条件そのものは変わりません。</p>
        </div>
        <IntelligencePingButton />
      </section>
    </main>
  );
}
