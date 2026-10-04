import { IntelligencePingButton } from "@/components/intelligence-ping-button";
import { OpportunityCard } from "@/components/opportunity-card";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import { getOpportunityKpis, listOpportunities } from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function IntelligencePage() {
  let error: string | null = null;
  let opportunities: Awaited<ReturnType<typeof listOpportunities>> = [];
  let kpis: Awaited<ReturnType<typeof getOpportunityKpis>> | null = null;
  try { [opportunities, kpis] = await Promise.all([listOpportunities(), getOpportunityKpis()]); }
  catch (caught) { error = caught instanceof SupabaseConfigError ? "商機データを読み込めません。時間をおいてもう一度お試しください。" : caught instanceof Error ? caught.message : "商機を読み込めませんでした。"; }

  return (
    <main className="tracer-editorial-page">
      <header className="tracer-editorial-hero">
        <div className="tracer-editorial-index"><span>03</span><span>DISCOVER / OPPORTUNITY</span><span>TRACE → TEST</span></div>
        <div className="tracer-editorial-hero-grid">
          <div><p className="tracer-kicker">Opportunity Intelligence</p><h1>数字の裏側に、<br /><em>試す理由</em>を見つける。</h1><p className="tracer-lede">需要、商品同一性、市場価格、仕入条件、利益、検索との相性。複数の証拠を重ね、足りない情報は足りないまま残します。</p></div>
          <aside className="tracer-editorial-note"><span>THE TRACER RULE / 01</span><strong>大きな数字より、<br />確認できる根拠。</strong><p>候補を増やすことではなく、判断できる候補を残す。</p></aside>
        </div>
        <div className="tracer-editorial-scan"><span>OBSERVE</span><span>IDENTIFY</span><span>VERIFY</span><span>TEST</span></div>
      </header>
      {error ? <p role="alert" className="tracer-alert">{error}</p> : <>
        {kpis ? <div className="tracer-section-frame"><OpportunityKpis kpis={kpis} /></div> : null}
        <section className="tracer-content-section" aria-labelledby="opportunity-list">
          <div className="tracer-section-heading"><div><span>CURATED OPPORTUNITIES</span><h2 id="opportunity-list">いま、確認する候補</h2></div><b>{opportunities.length.toString().padStart(2,"0")} / LIVE</b></div>
          {opportunities.length > 0 ? <div className="grid gap-5">{opportunities.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} />)}</div> : <div className="tracer-empty"><span>NEXT SELECTION / IN PROGRESS</span><h2>確認できる商機を探しています。</h2><p>需要・商品・仕入・価格の根拠が揃うまで、候補を無理に増やしません。新しい観測が入るたびに再確認します。</p></div>}
        </section>
      </>}
      <section className="tracer-footer-tool"><div><span>AI QUALITY CHECK</span><p>AIの補助が利用できるかを確認できます。公開条件そのものは変わりません。</p></div><IntelligencePingButton /></section>
    </main>
  );
}
