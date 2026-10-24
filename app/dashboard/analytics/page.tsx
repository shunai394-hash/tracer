import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  total: number | string | null;
  payment_status: string | null;
  order_status: string | null;
  created_at: string;
  base_order_key: string | null;
};

type OrderItemRow = {
  order_id: string;
  title: string | null;
  qty: number | null;
  unit_price: number | string | null;
};

type CommerceOrderRow = { id: string; channel: string | null; external_order_id: string | null; total_amount: number | string | null; payment_status: string | null; fulfillment_status: string | null; created_at: string };

type CommerceLineRow = { order_id: string; variant_id: string; quantity: number | null; unit_price: number | string | null };

type CommerceVariantRow = { id: string; product_id: string; title_ja: string | null };

type CommerceProductRow = { id: string; title_ja: string | null };

type BestsellerRow = {
  id: string;
  title: string | null;
  marketplace: string | null;
  category: string | null;
  rank: number | null;
  price: number | string | null;
  currency: string | null;
  review_count: number | null;
  product_url: string | null;
  image_url: string | null;
  fetched_at: string | null;
};

const yen = (value: number) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="border border-white/10 bg-white/[0.025] p-5">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-50">{value}</p>
      <p className="mt-2 text-xs leading-5 text-zinc-500">{note}</p>
    </article>
  );
}

export default async function SalesAnalyticsPage() {
  let dbError: string | null = null;
  let orders: OrderRow[] = [];
  let commerceOrders: CommerceOrderRow[] = [];
  let commerceLines: CommerceLineRow[] = [];
  let commerceVariants: CommerceVariantRow[] = [];
  let commerceProducts: CommerceProductRow[] = [];
  let commerceLoadError: string | null = null;
  let items: OrderItemRow[] = [];
  let listings: Array<{ id: string; title: string | null; published: boolean | null; selling_price: number | null; product_url: string | null }> = [];
  let bestsellerRows: BestsellerRow[] = [];
  let learningRows: Array<{ product_id: string | null; demand_query: string | null; actual_units: number | null; orders: number | null; revenue: number | null; demand_score: number | null; demand_trend: string | null; created_at: string }> = [];

  try {
    const supabase = createSupabaseAdminClient();
    const results = await Promise.all([
      supabase.from("shop_orders").select("id,total,payment_status,order_status,created_at,base_order_key").order("created_at", { ascending: false }).limit(500),
      supabase.from("shop_order_items").select("order_id,title,qty,unit_price").limit(3000),
      supabase.from("shop_listings").select("id,title,published,selling_price,product_url").order("created_at", { ascending: false }).limit(500),
      supabase.from("marketplace_bestsellers").select("id,title,marketplace,category,rank,price,currency,review_count,product_url,image_url,fetched_at").order("fetched_at", { ascending: false }).limit(200),
      supabase.from("demand_sales_learning").select("product_id,demand_query,actual_units,orders,revenue,demand_score,demand_trend,created_at").order("created_at", { ascending: false }).limit(500),
      supabase.from("commerce_orders").select("id,channel,external_order_id,total_amount,payment_status,fulfillment_status,created_at").order("created_at", { ascending: false }).limit(1000),
      supabase.from("commerce_order_lines").select("order_id,variant_id,quantity,unit_price").limit(10000),
      supabase.from("commerce_variants").select("id,product_id,title_ja").limit(10000),
      supabase.from("commerce_products").select("id,title_ja").limit(10000),
    ]);
    const errorResult = results.slice(0, 5).find((result) => result.error);
    if (errorResult?.error) throw new Error(errorResult.error.message);
    orders = results[0].data ?? [];
    items = results[1].data ?? [];
    listings = results[2].data ?? [];
    bestsellerRows = results[3].data ?? [];
    learningRows = results[4].data ?? [];
    const commerceError = results.slice(5).find((result) => result.error);
    if (commerceError?.error) {
      commerceLoadError = commerceError.error.message;
    } else {
      commerceOrders = results[5].data ?? [];
      commerceLines = results[6].data ?? [];
      commerceVariants = results[7].data ?? [];
      commerceProducts = results[8].data ?? [];
    }
  } catch (error) {
    dbError = error instanceof Error ? error.message : "管理データを読み込めませんでした。";
  }

  const paidOrders = orders.filter((order) => order.payment_status === "paid" && order.order_status !== "cancelled" && order.order_status !== "refunded");
  const paidCommerceOrders = commerceOrders.filter((order) => order.payment_status === "paid");
  const canonicalBaseOrderKeys = new Set(paidCommerceOrders.filter((order) => order.channel === "base").map((order) => String(order.external_order_id ?? "")).filter(Boolean));
  const uniqueLegacyPaidOrders = paidOrders.filter((order) => !order.base_order_key || !canonicalBaseOrderKeys.has(order.base_order_key));
  const paidOrderIds = new Set(uniqueLegacyPaidOrders.map((order) => order.id));
  const paidItems = items.filter((item) => paidOrderIds.has(item.order_id));
  const paidCommerceOrderIds = new Set(paidCommerceOrders.map((order) => order.id));
  const legacyRevenue = uniqueLegacyPaidOrders.reduce((sum, order) => sum + Number(order.total ?? 0), 0);
  const commerceRevenue = paidCommerceOrders.reduce((sum, order) => sum + Number(order.total_amount ?? 0), 0);
  const revenue = legacyRevenue + commerceRevenue;
  const variantById = new Map(commerceVariants.map((variant) => [variant.id, variant]));
  const productTitleById = new Map(commerceProducts.map((product) => [product.id, product.title_ja]));
  const sold = new Map<string, { title: string; quantity: number; revenue: number }>();
  const addSold = (titleValue: string | null | undefined, quantityValue: number | null, priceValue: number | string | null) => {
    const title = titleValue?.trim() || "商品名未記録";
    const current = sold.get(title) ?? { title, quantity: 0, revenue: 0 };
    const quantity = Number(quantityValue ?? 0);
    current.quantity += quantity;
    current.revenue += quantity * Number(priceValue ?? 0);
    sold.set(title, current);
  };
  for (const item of paidItems) addSold(item.title, item.qty, item.unit_price);
  for (const line of commerceLines) {
    if (!paidCommerceOrderIds.has(line.order_id)) continue;
    const variant = variantById.get(line.variant_id);
    const title = variant ? productTitleById.get(variant.product_id) || variant.title_ja : null;
    addSold(title, line.quantity, line.unit_price);
  }
  const topSold = [...sold.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 10);
  const activeListings = listings.filter((listing) => listing.published === true);
  const knownMarketplaceSources = new Set(bestsellerRows.map((row) => row.marketplace).filter(Boolean));
  const marketCandidates = [...bestsellerRows]
    .filter((row) => row.title)
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 10);
  const observedSales = learningRows.filter((row) => Number(row.actual_units ?? 0) > 0 || Number(row.orders ?? 0) > 0);
  const lastMarketUpdate = bestsellerRows.map((row) => row.fetched_at).filter((value): value is string => Boolean(value)).sort().at(-1);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-12 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">Sales intelligence</p>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-zinc-50">売上・売れ筋分析</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">
            注文実績と外部ランキング情報を分けて表示します。外部ランキングはTRACERでの販売実績ではありません。
          </p>
        </div>
        <a href="/dashboard" className="text-sm text-cyan-300 underline underline-offset-4">運用ダッシュボードへ戻る</a>
      </div>

      {dbError ? <p role="alert" className="mt-8 border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">データ取得エラー：{dbError}</p> : null}
      {commerceLoadError ? <p role="alert" className="mt-3 border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">正規注文台帳の取得に失敗したため、Shopify等の実績はこの集計に含まれていません：{commerceLoadError}</p> : null}

      <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="売上概要">
        <Metric label="旧注文台帳の注文" value={String(orders.length)} note="BASE等の旧 shop_orders 台帳（正規台帳との重複を売上集計から除外）" />
        <Metric label="正規台帳の決済済み注文" value={String(paidCommerceOrders.length)} note="Shopify等の commerce_orders 台帳" />
        <Metric label="集計した決済済み売上" value={yen(revenue)} note="旧台帳＋正規台帳。台帳別件数も確認してください" />
        <Metric label="公開中の商品" value={String(activeListings.length)} note={`登録商品 ${listings.length}件を確認`} />
      </section>

      <section className="mt-10 border border-white/10 p-5 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">実際に売れた商品</h2>
            <p className="mt-2 text-sm text-zinc-400">決済済み注文に記録された商品明細を販売数量順に集計しています。</p>
          </div>
          <span className="text-xs text-zinc-500">{topSold.length}商品</span>
        </div>
        {topSold.length ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-zinc-500"><tr><th className="py-3 pr-4">順位</th><th className="py-3 pr-4">商品</th><th className="py-3 pr-4 text-right">販売数</th><th className="py-3 text-right">商品売上</th></tr></thead>
              <tbody>{topSold.map((row, index) => <tr key={row.title} className="border-t border-white/8"><td className="py-4 pr-4 text-zinc-500">{index + 1}</td><td className="py-4 pr-4 text-zinc-100">{row.title}</td><td className="py-4 pr-4 text-right tabular-nums">{row.quantity}</td><td className="py-4 text-right tabular-nums">{yen(row.revenue)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : (
          <div className="mt-5 border border-white/8 bg-white/[0.02] p-6">
            <p className="font-medium text-zinc-200">現在、TRACERのDBに決済済み販売明細がありません。</p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">現在参照できる決済済み台帳に商品明細がありません。販売ゼロと断定せず、各販売チャネルの注文取込状態を確認してください。</p>
          </div>
        )}
      </section>

      <section className="mt-8 border border-white/10 p-5 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">外部マーケットの売れ筋候補</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">外部サイトのランキング取得データです。需要の参考情報であり、TRACER内で売れた証拠ではありません。</p>
          </div>
          <span className="text-xs text-zinc-500">{bestsellerRows.length}件取得 / {knownMarketplaceSources.size}ソース</span>
        </div>
        {marketCandidates.length ? (
          <div className="mt-5 space-y-3">
            {marketCandidates.map((row) => (
              <article key={row.id} className="flex flex-col gap-4 border border-white/8 p-4 sm:flex-row sm:items-center">
                {row.image_url ? <img src={row.image_url} alt="" className="h-20 w-20 rounded object-cover" loading="lazy" /> : <div className="flex h-20 w-20 shrink-0 items-center justify-center bg-white/5 text-xs text-zinc-600">画像なし</div>}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-6 text-zinc-100">{row.title}</p>
                  <p className="mt-1 text-xs text-zinc-500">{row.marketplace ?? "ソース不明"}{row.category ? ` · ${row.category}` : ""}{row.rank ? ` · 外部ランキング ${row.rank}位` : ""}</p>
                  <p className="mt-2 text-sm text-zinc-300">{row.price != null ? (row.currency === "JPY" ? yen(Number(row.price)) : `${row.price} ${row.currency ?? ""}`) : "価格不明"}{row.review_count != null ? ` · レビュー ${row.review_count.toLocaleString("ja-JP")}件` : ""}</p>
                  {row.fetched_at ? <p className="mt-1 text-[11px] text-zinc-600">取得日時：{new Date(row.fetched_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p> : null}
                </div>
                {row.product_url ? <a href={row.product_url} target="_blank" rel="noreferrer" className="shrink-0 text-sm text-cyan-300 underline underline-offset-4">外部商品を見る</a> : null}
              </article>
            ))}
          </div>
        ) : <p className="mt-5 border border-white/8 p-6 text-sm text-zinc-400">外部ランキングデータはまだありません。データ取得ジョブの実行が必要です。</p>}
        {lastMarketUpdate ? <p className="mt-4 text-xs text-zinc-500">最新取得：{new Date(lastMarketUpdate).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p> : null}
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <article className="border border-white/10 p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-zinc-100">需要・販売テストの実績</h2>
          <p className="mt-2 text-sm text-zinc-400">需要予測と実測値を記録する学習データです。</p>
          <p className="mt-5 text-2xl font-semibold text-zinc-50">{observedSales.length}件</p>
          <p className="mt-1 text-xs text-zinc-500">実販売数または注文数が記録されたレコード（全{learningRows.length}件）</p>
        </article>
        <article className="border border-white/10 p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-zinc-100">次に必要な接続</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-400">
            <li>旧注文台帳と正規注文台帳の件数・売上を別々に照合する</li>
            <li>商品明細のSKU・variant IDをTRACER商品へ正確に紐付ける</li>
            <li>キャンセル・返金・重複注文を除外し、チャネル別の実売上と利益を再集計する</li>
          </ul>
        </article>
      </section>
    </main>
  );
}
