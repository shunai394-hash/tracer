import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Listing = {
  id: string;
  title: string | null;
  published: boolean | null;
  selling_price: number | string | null;
  inventory: number | null;
  source_cost: number | string | null;
  shipping_cost: number | string | null;
  contribution_profit: number | string | null;
  supplier_name: string | null;
  orderable: boolean | null;
  pipeline_status: string | null;
  pipeline_reason: string | null;
  product_url: string | null;
  created_at: string;
};

type Item = {
  order_id: string;
  listing_id: string | null;
  product_id: string | null;
  title: string | null;
  qty: number | string | null;
  unit_price: number | string | null;
};

type Order = { id: string; payment_status: string | null; order_status: string | null; created_at: string };

const yen = (v: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(v);
const daysSince = (date: string) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));

export default async function ProductPerformancePage() {
  let error: string | null = null;
  let listings: Listing[] = [];
  let items: Item[] = [];
  let orders: Order[] = [];
  try {
    const db = createSupabaseAdminClient();
    const [l, i, o] = await Promise.all([
      db.from("shop_listings").select("id,title,published,selling_price,inventory,source_cost,shipping_cost,contribution_profit,supplier_name,orderable,pipeline_status,pipeline_reason,product_url,created_at").order("created_at", { ascending: false }).limit(5000),
      db.from("shop_order_items").select("order_id,listing_id,product_id,title,qty,unit_price").limit(20000),
      db.from("shop_orders").select("id,payment_status,order_status,created_at").limit(10000),
    ]);
    const failed = [l, i, o].find((x) => x.error);
    if (failed?.error) throw new Error(failed.error.message);
    listings = l.data ?? [];
    items = i.data ?? [];
    orders = o.data ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "商品実績を取得できませんでした。";
  }

  const paid = new Set(orders.filter((o) => o.payment_status === "paid" && o.order_status !== "cancelled" && o.order_status !== "refunded").map((o) => o.id));
  const byListing = new Map<string, { qty: number; revenue: number; lastSold: string | null }>();
  const orderById = new Map(orders.map((o) => [o.id, o]));
  for (const item of items) {
    if (!paid.has(item.order_id)) continue;
    const key = item.listing_id ?? item.product_id;
    if (!key) continue;
    const current = byListing.get(key) ?? { qty: 0, revenue: 0, lastSold: null };
    current.qty += Number(item.qty ?? 0);
    current.revenue += Number(item.qty ?? 0) * Number(item.unit_price ?? 0);
    const date = orderById.get(item.order_id)?.created_at ?? null;
    if (date && (!current.lastSold || date > current.lastSold)) current.lastSold = date;
    byListing.set(key, current);
  }
  const rows = listings.map((p) => {
    const s = byListing.get(p.id) ?? ({} as { qty?: number; revenue?: number; lastSold?: string | null });
    const hasSalesRecord = items.some((i) => i.listing_id === p.id || i.product_id === p.id);
    return { ...p, qty: s.qty ?? 0, revenue: s.revenue ?? 0, lastSold: s.lastSold ?? null, hasSalesRecord };
  }).sort((a, b) => a.qty - b.qty || daysSince(b.created_at) - daysSince(a.created_at));

  const noSales = rows.filter((p) => p.hasSalesRecord ? p.qty === 0 : true);
  const noSalesConfirmed = rows.filter((p) => p.qty === 0 && p.hasSalesRecord);
  const publishedNoSales = rows.filter((p) => p.published && p.qty === 0);
  const publishedWithNoSalesData = publishedNoSales.filter((p) => !p.hasSalesRecord);

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-10 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-cyan-400">Product performance</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-zinc-50">商品販売実績・入れ替え候補</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">販売実績ゼロの商品も一覧に含めます。実績明細がない商品は「未確認」と表示し、売上ゼロと断定しません。この画面は分析専用で、商品・公開状態・在庫を変更しません。</p>
        </div>
        <a href="/dashboard/analytics" className="text-sm text-cyan-300 underline underline-offset-4">売上分析へ戻る</a>
      </div>
      {error ? <p role="alert" className="mt-6 border border-amber-400/30 p-4 text-sm text-amber-200">データ取得エラー：{error}</p> : null}
      <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">管理対象商品</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{listings.length}</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">公開中・販売数ゼロ</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{publishedNoSales.length}</p><p className="mt-1 text-xs text-zinc-500">未確認 {publishedWithNoSalesData.length}件を含む</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">ゼロ販売を確認</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{noSalesConfirmed.length}</p><p className="mt-1 text-xs text-zinc-500">注文明細があり、有効な販売数がゼロ</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">仕入れ未確認</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{rows.filter((p) => !p.orderable || p.source_cost == null || p.shipping_cost == null).length}</p><p className="mt-1 text-xs text-zinc-500">仕入れ・送料・原価の確認が必要</p></article>
      </section>
      <section className="mt-8 border border-white/10 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-zinc-100">全商品一覧（販売数の少ない順）</h2><span className="text-xs text-zinc-500">表示 {rows.length}件 · 最新5000件まで</span></div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead className="text-xs text-zinc-500"><tr>{["商品","公開","販売数","商品売上","登録後","最終販売","在庫","販売価格","利益","仕入先・状態","入れ替え判断"].map((h) => <th key={h} className="border-b border-white/10 px-3 py-3">{h}</th>)}</tr></thead>
            <tbody>{rows.map((p) => {
              const age = daysSince(p.created_at);
              const profit = p.contribution_profit == null ? null : Number(p.contribution_profit);
              const reason = p.qty > 0 ? "販売実績あり" : !p.hasSalesRecord ? "販売データ未確認" : "販売数ゼロ";
              return <tr key={p.id} className="border-b border-white/5 align-top">
                <td className="max-w-[280px] px-3 py-4"><p className="font-medium text-zinc-100">{p.title || "商品名未設定"}</p><p className="mt-1 break-all text-[11px] text-zinc-600">{p.id}</p>{p.product_url ? <a href={p.product_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-cyan-300 underline">商品ページ</a> : null}</td>
                <td className="px-3 py-4 text-zinc-300">{p.published ? "公開中" : "非公開"}</td>
                <td className="px-3 py-4 tabular-nums text-zinc-100">{p.qty}</td>
                <td className="px-3 py-4 tabular-nums text-zinc-300">{yen(p.revenue)}</td>
                <td className="px-3 py-4 text-zinc-300">{age}日</td>
                <td className="px-3 py-4 text-zinc-300">{p.lastSold ? new Date(p.lastSold).toLocaleDateString("ja-JP") : "記録なし"}</td>
                <td className="px-3 py-4 tabular-nums text-zinc-300">{p.inventory ?? "不明"}</td>
                <td className="px-3 py-4 tabular-nums text-zinc-300">{p.selling_price == null ? "不明" : yen(Number(p.selling_price))}</td>
                <td className="px-3 py-4 tabular-nums">{profit == null ? <span className="text-amber-300">不明</span> : <span className={profit > 0 ? "text-emerald-300" : "text-rose-300"}>{yen(profit)}</span>}</td>
                <td className="px-3 py-4 text-zinc-300"><p>{p.supplier_name || "仕入先未紐付け"}</p><p className="mt-1 text-xs text-zinc-500">{p.orderable ? "仕入れ可" : p.pipeline_reason || p.pipeline_status || "要確認"}</p></td>
                <td className="px-3 py-4"><span className={p.qty === 0 ? "text-amber-300" : "text-emerald-300"}>{reason}</span><p className="mt-1 max-w-[180px] text-xs text-zinc-500">{p.qty === 0 ? (age >= 30 ? "掲載30日以上・販売ゼロ。入れ替え検討" : "経過日数と販売データを確認") : "継続候補。利益・在庫も確認"}</p></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">注意：この集計はTRACER内に取り込まれた注文・明細に基づきます。BASE・Shopifyの注文取込が未接続または欠落している場合、販売ゼロではなく「販売データ未確認」と判断してください。閲覧数・カート投入数がデータ連携されていない場合、この画面では表示しません。</p>
      </section>
    </main>
  );
}
