import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function hasConcreteIdentifier(row: Record<string, unknown>): boolean {
  return ["asin", "jan", "gtin", "ean", "upc", "mpn"].some((key) => {
    const value = row[key];
    return typeof value === "string" && value.trim().length > 0 && value.trim().toUpperCase() !== "UNKNOWN";
  });
}

function hasUsablePrice(row: Record<string, unknown>): boolean {
  return typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0;
}

function hasUsableUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export default async function BestsellersPage() {
  let rows: Array<Record<string, unknown>> = [];
  let excludedCount = 0;
  let error: string | null = null;
  try {
    const supabase = createSupabaseAdminClient();
    // Read a bounded recent window, then fail closed on incomplete observations.
    // Ranking presence alone is never sufficient evidence for a sellable product.
    const result = await supabase
      .from("marketplace_bestsellers")
      .select("id, marketplace, rank, title, brand, asin, jan, gtin, ean, upc, mpn, price, currency, review_count, product_url, image_url, fetched_at, source")
      .order("fetched_at", { ascending: false })
      .limit(500);
    if (result.error) throw new Error(result.error.message);
    const observed = (result.data ?? []) as Array<Record<string, unknown>>;
    const eligible = observed.filter((row) =>
      hasUsablePrice(row) &&
      hasConcreteIdentifier(row) &&
      hasUsableUrl(row.product_url) &&
      hasUsableUrl(row.image_url),
    );
    excludedCount = observed.length - eligible.length;
    rows = eligible.slice(0, 60);
  } catch (caught) {
    error = caught instanceof SupabaseConfigError ? "Supabase が未設定です。" : caught instanceof Error ? caught.message : "ランキングを読めませんでした。";
  }

  return (
    <main className="tracer-editorial-page">
      <header className="tracer-editorial-hero tracer-market-hero">
        <div className="tracer-editorial-index"><span>02</span><span>OBSERVE / MARKET</span><span>RAW SIGNAL</span></div>
        <div className="tracer-editorial-hero-grid">
          <div><p className="tracer-kicker">Market Observation</p><h1>売れ筋を、<br /><em>判断の前</em>に見る。</h1><p className="tracer-lede">Amazon.co.jp / 楽天市場 / Yahoo!ショッピングの観測データ。価格・識別子・商品画像が揃わない記録は一覧から除外し、ランキング情報を販売可能商品と混同しません。</p></div>
          <aside className="tracer-editorial-note"><span>USABLE OBSERVATIONS / {rows.length.toString().padStart(2,"0")}</span><strong>市場の信号と、<br />仕入れの証拠を分ける。</strong><p>ここに表示されても、仕入先の在庫・バリエーション・発注可否を確認するまでは販売掲載の承認ではありません。今回の観測窓で除外した不完全データ: {excludedCount} 件。</p></aside>
        </div>
        <div className="tracer-editorial-scan"><span>RANK</span><span>PRICE</span><span>IDENTITY</span><span>SOURCE</span></div>
      </header>
      {error ? <p role="alert" className="tracer-alert">{error}</p> : rows.length === 0 ? <div className="tracer-empty"><span>NO VERIFIED OBSERVATION FIELDS</span><h2>価格・識別子・画像が揃った観測はまだありません。</h2><p>不完全なランキング記録を販売候補として表示せず、証拠が揃ったデータを待ちます。</p></div> : <section className="tracer-market-list" aria-label="Usable market observations">
        {rows.map((row, index) => {
          const url = hasUsableUrl(row.product_url) ? row.product_url : null;
          const rank = row.rank == null ? index + 1 : row.rank;
          const identity = ["asin", "jan", "gtin", "ean", "upc", "mpn"]
            .map((key) => row[key])
            .find((value) => typeof value === "string" && value.trim() && value.trim().toUpperCase() !== "UNKNOWN");
          return <article key={String(row.id)} className="tracer-market-row">
            <div className="tracer-rank">{String(rank).padStart(2,"0")}</div>
            <div className="min-w-0"><div className="tracer-row-meta"><span>{String(row.marketplace)}</span><span>{String(row.source)}</span>{row.brand ? <span>{String(row.brand)}</span> : null}</div><h2>{String(row.title)}</h2><div className="tracer-row-data"><span>PRICE <b>{formatMoney(typeof row.price === "number" ? row.price : null, typeof row.currency === "string" ? row.currency : null)}</b></span><span>IDENTITY <b>{String(identity)}</b></span>{row.review_count != null ? <span>REVIEWS <b>{String(row.review_count)}</b></span> : null}</div></div>
            {url ? <a href={url} target="_blank" rel="noreferrer">SOURCE ↗</a> : <span className="tracer-source-missing">SOURCE UNKNOWN</span>}
          </article>;
        })}
      </section>}
    </main>
  );
}
