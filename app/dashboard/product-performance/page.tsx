import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Listing = {
  id: string; title: string | null; published: boolean | null; selling_price: number | string | null;
  inventory: number | null; source_cost: number | string | null; shipping_cost: number | string | null;
  contribution_profit: number | string | null; supplier_name: string | null; orderable: boolean | null;
  pipeline_status: string | null; pipeline_reason: string | null; product_url: string | null; created_at: string;
};
type LegacyItem = { order_id: string; listing_id: string | null; product_id: string | null; title: string | null; qty: number | string | null; unit_price: number | string | null };
type LegacyOrder = { id: string; payment_status: string | null; order_status: string | null; created_at: string };
type CommerceOrder = { id: string; channel: string | null; external_order_id: string | null; total_amount: number | string | null; payment_status: string | null; fulfillment_status: string | null; created_at: string };
type CommerceLine = { order_id: string; variant_id: string; quantity: number | null; unit_price: number | string | null };
type Variant = { id: string; product_id: string; title_ja: string | null };
type Product = { id: string; title_ja: string | null };

const yen = (v: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(v);
const daysSince = (date: string) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));

export default async function ProductPerformancePage() {
  let error: string | null = null;
  let listings: Listing[] = [];
  let legacyItems: LegacyItem[] = [];
  let legacyOrders: LegacyOrder[] = [];
  let commerceOrders: CommerceOrder[] = [];
  let commerceLines: CommerceLine[] = [];
  let variants: Variant[] = [];
  let products: Product[] = [];
  let commerceError: string | null = null;
  try {
    const db = createSupabaseAdminClient();
    const [l, li, lo, co, cl, v, p] = await Promise.all([
      db.from("shop_listings").select("id,title,published,selling_price,inventory,source_cost,shipping_cost,contribution_profit,supplier_name,orderable,pipeline_status,pipeline_reason,product_url,created_at").order("created_at", { ascending: false }).limit(5000),
      db.from("shop_order_items").select("order_id,listing_id,product_id,title,qty,unit_price").limit(20000),
      db.from("shop_orders").select("id,payment_status,order_status,created_at").limit(10000),
      db.from("commerce_orders").select("id,channel,external_order_id,total_amount,payment_status,fulfillment_status,created_at").order("created_at", { ascending: false }).limit(10000),
      db.from("commerce_order_lines").select("order_id,variant_id,quantity,unit_price").limit(30000),
      db.from("commerce_variants").select("id,product_id,title_ja").limit(10000),
      db.from("commerce_products").select("id,title_ja").limit(10000),
    ]);
    const legacyFailure = [l, li, lo].find((x) => x.error);
    if (legacyFailure?.error) throw new Error(legacyFailure.error.message);
    listings = l.data ?? []; legacyItems = li.data ?? []; legacyOrders = lo.data ?? [];
    const canonicalFailure = [co, cl, v, p].find((x) => x.error);
    if (canonicalFailure?.error) commerceError = canonicalFailure.error.message;
    else {
      commerceOrders = co.data ?? []; commerceLines = cl.data ?? []; variants = v.data ?? []; products = p.data ?? [];
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "商品実績を取得できませんでした。";
  }

  const paidLegacy = new Set(legacyOrders.filter((o) => o.payment_status === "paid" && o.order_status !== "cancelled" && o.order_status !== "refunded").map((o) => o.id));
  const legacyOrderById = new Map(legacyOrders.map((o) => [o.id, o]));
  const legacyByListing = new Map<string, { qty: number; revenue: number; lastSold: string | null; hasRecord: boolean }>();
  for (const item of legacyItems) {
    const key = item.listing_id ?? item.product_id;
    if (!key) continue;
    const row = legacyByListing.get(key) ?? { qty: 0, revenue: 0, lastSold: null, hasRecord: false };
    row.hasRecord = true;
    if (paidLegacy.has(item.order_id)) {
      row.qty += Number(item.qty ?? 0);
      row.revenue += Number(item.qty ?? 0) * Number(item.unit_price ?? 0);
      const date = legacyOrderById.get(item.order_id)?.created_at ?? null;
      if (date && (!row.lastSold || date > row.lastSold)) row.lastSold = date;
    }
    legacyByListing.set(key, row);
  }

  const paidCanonical = commerceOrders.filter((o) => o.payment_status === "paid");
  const paidCanonicalIds = new Set(paidCanonical.map((o) => o.id));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const soldProducts = new Map<string, { title: string; quantity: number; revenue: number; lastSold: string | null; channels: Set<string> }>();
  for (const line of commerceLines) {
    if (!paidCanonicalIds.has(line.order_id)) continue;
    const variant = variantById.get(line.variant_id);
    if (!variant) continue;
    const product = productById.get(variant.product_id);
    const key = variant.product_id;
    const current = soldProducts.get(key) ?? { title: product?.title_ja || variant.title_ja || "商品名未記録", quantity: 0, revenue: 0, lastSold: null, channels: new Set<string>() };
    current.quantity += Number(line.quantity ?? 0);
    current.revenue += Number(line.quantity ?? 0) * Number(line.unit_price ?? 0);
    const order = commerceOrders.find((o) => o.id === line.order_id);
    if (order?.channel) current.channels.add(order.channel);
    if (order?.created_at && (!current.lastSold || order.created_at > current.lastSold)) current.lastSold = order.created_at;
    soldProducts.set(key, current);
  }
  const canonicalRevenue = paidCanonical.reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0);
  const canonicalByChannel = ["base", "shopify"].map((channel) => ({
    channel, orders: commerceOrders.filter((o) => o.channel === channel).length,
    paid: paidCanonical.filter((o) => o.channel === channel).length,
    revenue: paidCanonical.filter((o) => o.channel === channel).reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0),
    latest: commerceOrders.filter((o) => o.channel === channel).map((o) => o.created_at).sort().at(-1) ?? null,
  }));
  const rows = listings.map((p) => {
    const s = legacyByListing.get(p.id);
    return { ...p, qty: s?.qty ?? 0, revenue: s?.revenue ?? 0, lastSold: s?.lastSold ?? null, hasSalesRecord: s?.hasRecord ?? false };
  }).sort((a, b) => a.qty - b.qty || daysSince(b.created_at) - daysSince(a.created_at));
  const publishedNoSales = rows.filter((p) => p.published && p.qty === 0);
  const publishedWithNoSalesData = publishedNoSales.filter((p) => !p.hasSalesRecord);

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-10 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-cyan-400">Product performance</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-3xl font-semibold text-zinc-50">商品販売実績・入れ替え候補</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">販売数・売上は注文台帳を基に集計します。販売データがない商品を売上ゼロと断定しません。この画面は分析専用です。</p></div>
        <a href="/dashboard/analytics" className="text-sm text-cyan-300 underline underline-offset-4">売上分析へ戻る</a>
      </div>
      {error ? <p role="alert" className="mt-6 border border-amber-400/30 p-4 text-sm text-amber-200">データ取得エラー：{error}</p> : null}
      <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">BASE注文（全状態）</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{canonicalByChannel.find((x) => x.channel === "base")?.orders ?? "未取得"}</p><p className="mt-1 text-xs text-zinc-500">支払済 {canonicalByChannel.find((x) => x.channel === "base")?.paid ?? "—"}</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">Shopify注文（全状態）</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{canonicalByChannel.find((x) => x.channel === "shopify")?.orders ?? "未取得"}</p><p className="mt-1 text-xs text-zinc-500">支払済 {canonicalByChannel.find((x) => x.channel === "shopify")?.paid ?? "—"}</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">支払済売上（注文台帳）</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{yen(canonicalRevenue)}</p><p className="mt-1 text-xs text-zinc-500">正規台帳・二重計上を避けるため旧台帳分は別集計</p></article>
        <article className="border border-white/10 p-5"><p className="text-xs text-zinc-400">管理対象商品</p><p className="mt-2 text-2xl font-semibold text-zinc-50">{listings.length}</p><p className="mt-1 text-xs text-zinc-500">公開中・販売数ゼロ {publishedNoSales.length}件（未確認 {publishedWithNoSalesData.length}件）</p></article>
      </section>
      {commerceError ? <p role="alert" className="mt-4 border border-amber-400/30 p-4 text-sm text-amber-200">正規注文台帳を取得できませんでした。商品別の正規実績は未確認です：{commerceError}</p> : null}
      <section className="mt-8 border border-white/10 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-zinc-100">販売先別・注文同期の状態</h2>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr>{["販売先","注文数","支払済","支払済売上","最終注文記録"].map((h) => <th key={h} className="border-b border-white/10 px-3 py-3">{h}</th>)}</tr></thead>
          <tbody>{canonicalByChannel.map((x) => <tr key={x.channel} className="border-b border-white/5"><td className="px-3 py-3 text-zinc-100">{x.channel === "base" ? "BASE" : "Shopify"}</td><td className="px-3 py-3 tabular-nums">{x.orders}</td><td className="px-3 py-3 tabular-nums">{x.paid}</td><td className="px-3 py-3 tabular-nums">{yen(x.revenue)}</td><td className="px-3 py-3 text-zinc-400">{x.latest ? new Date(x.latest).toLocaleString("ja-JP") : "記録なし"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="mt-8 border border-white/10 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-zinc-100">正規注文台帳：売れた商品</h2>
        <p className="mt-2 text-sm text-zinc-400">支払済みの commerce_orders / commerce_order_lines から集計。注文が0件なら販売実績も0件です。</p>
        {soldProducts.size === 0 ? <p className="mt-4 border border-white/10 p-4 text-sm text-zinc-400">正規台帳に支払済みの商品明細はありません。これは「注文台帳上で実績なし」を示し、販売先管理画面の注文数を直接保証するものではありません。</p> :
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr>{["商品","販売数","商品売上","販売先","最終販売"].map((h) => <th key={h} className="border-b border-white/10 px-3 py-3">{h}</th>)}</tr></thead><tbody>{[...soldProducts.values()].sort((a,b) => b.quantity-a.quantity).map((p,i) => <tr key={p.title + i} className="border-b border-white/5"><td className="px-3 py-3 text-zinc-100">{p.title}</td><td className="px-3 py-3 tabular-nums">{p.quantity}</td><td className="px-3 py-3 tabular-nums">{yen(p.revenue)}</td><td className="px-3 py-3">{[...p.channels].join(", ")}</td><td className="px-3 py-3 text-zinc-400">{p.lastSold ? new Date(p.lastSold).toLocaleDateString("ja-JP") : "—"}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="mt-8 border border-white/10 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-zinc-100">商品別一覧（旧商品台帳の販売実績）</h2><span className="text-xs text-zinc-500">表示 {rows.length}件 · 最新5000件まで</span></div>
        <p className="mt-2 text-xs text-zinc-500">以下の商品別数値は shop_orders / shop_order_items に保存された旧台帳の実績です。正規台帳の売れた商品は上の表を参照してください。</p>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr>{["商品","公開","販売数","商品売上","登録後","最終販売","在庫","販売価格","利益","仕入先・状態","判断"].map((h) => <th key={h} className="border-b border-white/10 px-3 py-3">{h}</th>)}</tr></thead>
          <tbody>{rows.map((p) => { const age = daysSince(p.created_at); const profit = p.contribution_profit == null ? null : Number(p.contribution_profit); const reason = p.qty > 0 ? "販売実績あり" : !p.hasSalesRecord ? "販売データ未確認" : "販売数ゼロ"; return <tr key={p.id} className="border-b border-white/5 align-top">
            <td className="max-w-[280px] px-3 py-4"><p className="font-medium text-zinc-100">{p.title || "商品名未設定"}</p><p className="mt-1 break-all text-[11px] text-zinc-600">{p.id}</p>{p.product_url ? <a href={p.product_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-cyan-300 underline">商品ページ</a> : null}</td>
            <td className="px-3 py-4 text-zinc-300">{p.published ? "公開中" : "非公開"}</td><td className="px-3 py-4 tabular-nums">{p.qty}</td><td className="px-3 py-4 tabular-nums">{yen(p.revenue)}</td><td className="px-3 py-4">{age}日</td><td className="px-3 py-4">{p.lastSold ? new Date(p.lastSold).toLocaleDateString("ja-JP") : "記録なし"}</td><td className="px-3 py-4">{p.inventory ?? "不明"}</td><td className="px-3 py-4">{p.selling_price == null ? "不明" : yen(Number(p.selling_price))}</td><td className="px-3 py-4">{profit == null ? <span className="text-amber-300">不明</span> : <span className={profit > 0 ? "text-emerald-300" : "text-rose-300"}>{yen(profit)}</span>}</td><td className="px-3 py-4"><p>{p.supplier_name || "仕入先未紐付け"}</p><p className="mt-1 text-xs text-zinc-500">{p.orderable ? "仕入れ可" : p.pipeline_reason || p.pipeline_status || "要確認"}</p></td><td className="px-3 py-4"><span className={p.qty === 0 ? "text-amber-300" : "text-emerald-300"}>{reason}</span><p className="mt-1 max-w-[180px] text-xs text-zinc-500">{p.qty === 0 ? (age >= 30 ? "掲載30日以上・入れ替え検討" : "経過日数と販売データを確認") : "継続候補。利益・在庫も確認"}</p></td>
          </tr>; })}</tbody></table></div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">閲覧数・カート投入数が連携されていない場合、この画面には表示しません。実際の購入を発生させずに集計しています。</p>
      </section>
    </main>
  );
}
