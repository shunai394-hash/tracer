import Link from "next/link";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Listing = {
  id: string;
  title: string | null;
  product_url: string | null;
  base_item_id: string | null;
  shopify_product_id: string | null;
  supplier_name: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  selling_price: number | string | null;
  source_cost: number | string | null;
  shipping_cost: number | string | null;
  contribution_profit: number | string | null;
  inventory: number | null;
  published: boolean | null;
  published_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  base_publication_status: string | null;
  shopify_sync_status: string | null;
};
type Order = { id: string; status: string | null; payment_status: string | null; order_status: string | null; created_at: string | null; paid_at: string | null; cancelled_at: string | null; refunded_at: string | null };
type OrderItem = { listing_id: string | null; product_id: string | null; title: string | null; qty: number | string | null; unit_price: number | string | null; order_id: string };

const yen = (value: unknown) => Number.isFinite(Number(value)) ? "¥" + Math.round(Number(value)).toLocaleString("ja-JP") : "—";
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString("ja-JP") : "—";

export default async function UnsoldProductsPage() {
  let listings: Listing[] = [];
  let orders: Order[] = [];
  let items: OrderItem[] = [];
  let error = "";

  try {
    const db = createSupabaseAdminClient();
    const [listingResult, orderResult, itemResult] = await Promise.all([
      db.from("shop_listings").select("id,title,product_url,base_item_id,shopify_product_id,supplier_name,supplier_product_id,supplier_variant_id,selling_price,source_cost,shipping_cost,contribution_profit,inventory,published,published_at,updated_at,archived_at,archive_reason,base_publication_status,shopify_sync_status").order("updated_at", { ascending: false }).limit(5000),
      db.from("shop_orders").select("id,status,payment_status,order_status,created_at,paid_at,cancelled_at,refunded_at").limit(10000),
      db.from("shop_order_items").select("listing_id,product_id,title,qty,unit_price,order_id").limit(20000),
    ]);
    if (listingResult.error) throw new Error("商品データ: " + listingResult.error.message);
    if (orderResult.error) throw new Error("注文データ: " + orderResult.error.message);
    if (itemResult.error) throw new Error("注文明細: " + itemResult.error.message);
    listings = (listingResult.data ?? []) as Listing[];
    orders = (orderResult.data ?? []) as Order[];
    items = (itemResult.data ?? []) as OrderItem[];
  } catch (e) {
    if (!(e instanceof SupabaseConfigError)) error = e instanceof Error ? e.message : "データを読み込めませんでした。";
  }

  const validOrders = new Map(orders.filter((o) => {
    const state = [o.payment_status, o.order_status, o.status].map((x) => String(x ?? "").toLowerCase());
    return !o.cancelled_at && !o.refunded_at && state.some((x) => ["paid", "fulfilled", "shipped", "completed", "success", "partially_refunded"].includes(x));
  }).map((o) => [o.id, o]));
  const sales = new Map<string, { units: number; revenue: number; lastSold: string | null }>();
  for (const item of items) {
    if (!item.listing_id || !validOrders.has(item.order_id)) continue;
    const order = validOrders.get(item.order_id)!;
    const row = sales.get(item.listing_id) ?? { units: 0, revenue: 0, lastSold: null };
    row.units += Math.max(0, Number(item.qty) || 0);
    row.revenue += (Number(item.qty) || 0) * (Number(item.unit_price) || 0);
    const soldAt = order.paid_at || order.created_at;
    if (soldAt && (!row.lastSold || Date.parse(soldAt) > Date.parse(row.lastSold))) row.lastSold = soldAt;
    sales.set(item.listing_id, row);
  }

  const neverSold = listings.filter((l) => (sales.get(l.id)?.units ?? 0) === 0);
  const ranked = [...neverSold].sort((a, b) => {
    const aDate = Date.parse(a.published_at || a.updated_at || a.archived_at || "") || 0;
    const bDate = Date.parse(b.published_at || b.updated_at || b.archived_at || "") || 0;
    return aDate - bDate;
  });
  const activeCount = listings.filter((l) => !l.archived_at && l.published).length;
  const archivedCount = listings.filter((l) => Boolean(l.archived_at)).length;
  const withSupplier = listings.filter((l) => Boolean(l.supplier_product_id && l.supplier_variant_id)).length;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-5 border-b border-white/10 pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[.3em] text-cyan-300/80">Catalog / Sales History / Replacement Prep</p>
          <h1 className="mt-3 text-4xl font-medium tracking-tight text-zinc-50">未販売商品・入れ替え候補</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400">商品を削除・入れ替えずに、掲載履歴、販売実績、仕入先バリエーション、原価・送料・利益を確認する管理画面です。ここでは商品データの変更や発注は行いません。</p>
        </div>
        <Link href="/products" className="w-fit border border-white/10 px-4 py-3 text-xs text-zinc-300 hover:border-cyan-300/40">商品管理へ戻る ↗</Link>
      </header>

      {error ? <p className="mt-8 border border-amber-500/30 p-4 text-sm text-amber-200">読み込みエラー: {error}</p> : null}

      <section className="mt-8 grid gap-px border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["管理対象商品", listings.length, "掲載中・停止・アーカイブを含む"],
          ["現在公開中", activeCount, "published=true かつ未アーカイブ"],
          ["未販売候補", ranked.length, "連携済み注文データに販売明細なし"],
          ["仕入先紐づけ済み", withSupplier, "仕入先商品ID・バリエーションIDあり"],
        ].map(([label, value, note]) => <div key={String(label)} className="bg-[#080b0e] p-5">
          <p className="font-mono text-[9px] tracking-widest text-zinc-500">{label}</p>
          <p className="mt-2 text-3xl text-zinc-100">{value}</p>
          <p className="mt-2 text-xs text-zinc-600">{note}</p>
        </div>)}
      </section>

      <div className="mt-6 flex flex-wrap gap-3 text-xs text-zinc-400">
        <span className="border border-white/10 px-3 py-2">アーカイブ済み {archivedCount} 件も保持</span>
        <span className="border border-white/10 px-3 py-2">販売データ参照: TRACER shop_orders / shop_order_items</span>
        <span className="border border-white/10 px-3 py-2">最大 {listings.length.toLocaleString("ja-JP")} 商品を読込</span>
      </div>

      <section className="mt-10">
        <div className="mb-4">
          <h2 className="text-xl font-medium text-zinc-100">未販売商品一覧</h2>
          <p className="mt-2 text-xs leading-6 text-zinc-500">公開日が古い順。販売データがまだ同期されていない商品も未販売候補に見えるため、入れ替え判断の前にBASE・Shopify側の注文同期状態も確認してください。</p>
        </div>
        {ranked.length === 0 ? <p className="border border-white/10 p-6 text-sm text-zinc-500">未販売候補はありません。データ読み込みエラーがある場合は先に解消してください。</p> : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full min-w-[1250px] border-collapse text-left text-xs">
              <thead className="bg-white/5 text-zinc-400">
                <tr>{["商品名 / 商品ID","販売状態","販売価格","原価 + 日本送料","想定利益","在庫","販売日 / 更新日","販売数","仕入先紐づけ","BASE / Shopify","アーカイブ理由"].map((x) => <th key={x} className="whitespace-nowrap border-b border-white/10 px-4 py-3 font-medium">{x}</th>)}</tr>
              </thead>
              <tbody>
                {ranked.map((l) => {
                  const stat = sales.get(l.id);
                  const supplierLinked = Boolean(l.supplier_product_id && l.supplier_variant_id);
                  const status = l.archived_at ? "アーカイブ" : l.published ? "公開中" : "非公開";
                  return <tr key={l.id} className="border-b border-white/5 align-top hover:bg-white/[.025]">
                    <td className="max-w-[260px] px-4 py-4">
                      <p className="max-w-[260px] whitespace-normal text-sm text-zinc-200">{l.title || "名称未設定"}</p>
                      <p className="mt-1 break-all font-mono text-[9px] text-zinc-600">{l.id}</p>
                      {l.product_url ? <a className="mt-2 inline-block text-cyan-300 hover:underline" href={l.product_url} target="_blank" rel="noreferrer">商品ページ ↗</a> : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-zinc-300">{status}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-zinc-200">{yen(l.selling_price)}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-zinc-400">{yen(l.source_cost)} + {yen(l.shipping_cost)}</td>
                    <td className="whitespace-nowrap px-4 py-4">{Number(l.contribution_profit) > 0 ? <span className="text-emerald-300">{yen(l.contribution_profit)}</span> : <span className="text-amber-300">{yen(l.contribution_profit)}</span>}</td>
                    <td className="px-4 py-4 text-zinc-300">{l.inventory ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-zinc-400">{date(l.published_at)}<p className="mt-1 text-[10px] text-zinc-600">更新 {date(l.updated_at)}</p></td>
                    <td className="px-4 py-4 text-zinc-300">0 個<p className="mt-1 text-[10px] text-zinc-600">最終販売 {date(stat?.lastSold)}</p></td>
                    <td className="max-w-[210px] px-4 py-4">
                      <p className={supplierLinked ? "text-emerald-300" : "text-amber-300"}>{supplierLinked ? "ID紐づけあり" : "未紐づけ"}</p>
                      <p className="mt-1 break-all font-mono text-[9px] text-zinc-600">{l.supplier_name || "仕入先未設定"}</p>
                      <p className="mt-1 break-all font-mono text-[9px] text-zinc-600">商品 {l.supplier_product_id || "—"}</p>
                      <p className="mt-1 break-all font-mono text-[9px] text-zinc-600">SKU/variant {l.supplier_variant_id || "—"}</p>
                    </td>
                    <td className="max-w-[190px] px-4 py-4 text-zinc-400">
                      <p>BASE: {l.base_item_id ? l.base_publication_status || "IDあり" : "未連携"}</p>
                      <p className="mt-1">Shopify: {l.shopify_product_id ? l.shopify_sync_status || "IDあり" : "未連携"}</p>
                    </td>
                    <td className="max-w-[180px] whitespace-normal px-4 py-4 text-zinc-500">{l.archive_reason || "—"}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="mt-6 text-[10px] leading-5 text-zinc-600">注意: 現在の注文明細に listing_id で一致する販売記録を使って集計しています。外部ストアの注文がTRACERへ同期されていない場合、実際に売れていても未販売として表示される可能性があります。販売履歴は削除せず、商品入れ替え時の比較用データとして保持します。</p>
    </main>
  );
}
