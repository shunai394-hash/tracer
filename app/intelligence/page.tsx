import { IntelligencePingButton } from "@/components/intelligence-ping-button";
import { OpportunityCard } from "@/components/opportunity-card";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import {
  getOpportunityKpis,
  listOpportunities,
} from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function IntelligencePage() {
  const configured = isGeminiConfigured();

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
        ? "Supabase が未設定のため Opportunity を読めません。"
        : caught instanceof Error
          ? caught.message
          : "Opportunity を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Opportunities
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">商機と販売テスト優先度</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        スコアは「勝ち商品」の断定ではありません。並び順は TEST PRIORITY です。
        不足している値は 0 点ではなく unknown です。
      </p>

      {error ? (
        <p className="mt-8 text-sm text-amber-300">{error}</p>
      ) : (
        <>
          {kpis ? <div className="mt-10"><OpportunityKpis kpis={kpis} /></div> : null}

          <div className="mt-10 grid gap-5">
            {opportunities.length > 0 ? (
              opportunities.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                />
              ))
            ) : (
              <div className="border border-dashed border-cyan-500/20 p-10 text-center">
                <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">
                  No opportunities yet
                </p>
                <p className="mt-3 text-sm text-zinc-400">
                  需要・供給・価格の実データが揃うまで、商機カードは表示しません。
                </p>
              </div>
            )}
          </div>
        </>
      )}

      <section className="mt-16 max-w-xl border border-cyan-500/15 bg-black/40 p-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          Gemini
        </p>
        <p className="mt-2 text-sm text-zinc-300">
          分類補助:{" "}
          <span className={configured ? "text-emerald-400" : "text-amber-400"}>
            {configured ? "キー設定あり" : "未設定"}
          </span>
        </p>
        <IntelligencePingButton />
      </section>
    </main>
  );
}
