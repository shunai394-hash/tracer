import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function BestsellersPage() {
  let rows: Array<Record<string, unknown>> = [];
  let error: string | null = null;
  try {
    const supabase = createSupabaseAdminClient();
    const result = await supabase.from("marketplace_bestsellers").select("id, marketplace, rank, title, brand, asin, jan, price, currency, review_count, product_url, fetched_at, source").order("fetched_at", { ascending: false }).limit(60);
    if (result.error) throw new Error(result.error.message);
    rows = (result.data ?? []) as Array<Record<string, unknown>>;
  } catch (caught) { error = caught instanceof SupabaseConfigError ? "Supabase が未設定です。" : caught instanceof Error ? caught.message : "ランキングを読めませんでした。"; }

  return (
    <main className="tracer-editorial-page">
      <header className="tracer-editorial-hero tracer-market-hero">
        <div className="tracer-editorial-index"><span>02</span><span>OBSERVE / MARKET</span><span>RAW SIGNAL</span></div>
        <div className="tracer-editorial-hero-grid">
          <div><p className="tracer-kicker">Market Observation</p><h1>売れ筋を、<br /><em>判断の前</em>に見る。</h1><p className="tracer-lede">Amazon.co.jp / 楽天市場 / Yahoo!ショッピングから得た観測。ここでは市場の事実と、TRACERの仕入判断を混ぜません。</p></div>
          <aside className="tracer-editorial-note"><span>OBSERVED / {rows.length.toString().padStart(2,"0")}</span><strong>市場は答えではない。<br />最初の信号だ。</strong><p>ランキング、価格、識別子。観測を次の検証へ渡す。</p></aside>
        </div>
        <div className="tracer-editorial-scan"><span>RANK</span><span>PRICE</span><span>IDENTITY</span><span>SOURCE</span></div>
      </header>
      {error ? <p role="alert" className="tracer-alert">{error}</p> : rows.length === 0 ? <div className="tracer-empty"><span>NO OBSERVATIONS</span><h2>観測された売れ筋はまだありません。</h2><p>新しい市場データが入ると、ここに事実として記録されます。</p></div> : <section className="tracer-market-list" aria-label="Market observations">
        {rows.map((row, index) => {
          const url = typeof row.product_url === "string" ? row.product_url : null;
          const rank = row.rank == null ? index + 1 : row.rank;
          return <article key={String(row.id)} className="tracer-market-row">
            <div className="tracer-rank">{String(rank).padStart(2,"0")}</div>
            <div className="min-w-0"><div className="tracer-row-meta"><span>{String(row.marketplace)}</span><span>{String(row.source)}</span>{row.brand ? <span>{String(row.brand)}</span> : null}</div><h2>{String(row.title)}</h2><div className="tracer-row-data"><span>PRICE <b>{formatMoney(typeof row.price === "number" ? row.price : null, typeof row.currency === "string" ? row.currency : null)}</b></span><span>ASIN <b>{row.asin ? String(row.asin) : "UNKNOWN"}</b></span><span>JAN <b>{row.jan ? String(row.jan) : "UNKNOWN"}</b></span>{row.review_count != null ? <span>REVIEWS <b>{String(row.review_count)}</b></span> : null}</div></div>
            {url ? <a href={url} target="_blank" rel="noreferrer">SOURCE ↗</a> : <span className="tracer-source-missing">SOURCE UNKNOWN</span>}
          </article>;
        })}
      </section>}
    </main>
  );
}
