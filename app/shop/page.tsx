import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shop — TRACER", description: "TRACERのSales Test Gateを通過し、Shopifyへ同期された販売中の商品。" };

export default async function ShopPage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let error: string | null = null;
  try { listings = await listPublishedShopListings(); }
  catch (caught) { error = caught instanceof SupabaseConfigError ? "店舗データを読み込めません。時間をおいてもう一度お試しください。" : caught instanceof Error ? caught.message : "店舗を読み込めませんでした。"; }

  return (
    <main className="tracer-editorial-page">
      <header className="tracer-editorial-hero tracer-shop-hero">
        <div className="tracer-editorial-index"><span>01</span><span>SHOPIFY / STORE</span><span>{String(listings.length).padStart(2, "0")} LIVE</span></div>
        <div className="tracer-editorial-hero-grid">
          <div><p className="tracer-kicker">TRACER × Shopify</p><h1>「気になる」を、<br /><em>買える</em>まで。</h1><p className="tracer-lede">Sales Test Gateを通過し、Shopifyへ同期され、在庫・配送・注文可能性まで確認できる商品だけを並べます。</p></div>
          <aside className="tracer-editorial-note"><span>CHANNEL CONTRACT</span><strong>GATE → SHOPIFY →<br />STORE。</strong><p>TRACERだけの下書きは表示しません。</p><Link href="/bestsellers">選定の背景を見る ↗</Link></aside>
        </div>
        <div className="tracer-editorial-scan"><span>GATE PASSED</span><span>SHOPIFY SYNCED</span><span>IN STOCK</span><span>ORDERABLE</span><span>TRACKABLE</span></div>
      </header>

      {error ? <p role="alert" className="tracer-alert">{error}</p> : listings.length === 0 ? (
        <section className="tracer-empty" aria-labelledby="empty-heading">
          <span>SHOPIFY CATALOG / 00 LIVE</span><h2 id="empty-heading">現在、販売可能なShopify商品はありません。</h2>
          <p>商品を捏造して埋めることはしません。Sales Test Gate、Shopify同期、在庫、注文可能性、追跡可能性をすべて満たした商品だけが自動でここに現れます。</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3"><Link href="/bestsellers" className="border border-cyan-300/30 px-5 py-3 text-xs text-cyan-100 hover:bg-cyan-300/10">売れ筋を見る →</Link><Link href="/intelligence" className="border border-white/10 px-5 py-3 text-xs text-zinc-300 hover:border-white/20">商機を見る →</Link></div>
        </section>
      ) : (
        <section className="tracer-content-section" aria-labelledby="catalog-heading">
          <div className="tracer-section-heading"><div><span>SHOPIFY CATALOG</span><h2 id="catalog-heading">販売中の商品</h2></div><b>{String(listings.length).padStart(2, "0")} ITEMS</b></div>
          <div className="grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listings.map((listing, index) => <Link key={listing.id} href={`/shop/${listing.slug}`} className="group flex h-full flex-col bg-[#080b0e] transition duration-500 hover:-translate-y-1 hover:bg-[#0b1014] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-inset">
              <div className="relative overflow-hidden bg-zinc-900">
                {listing.imageUrl ? <img src={listing.imageUrl} alt="" loading={index < 4 ? "eager" : "lazy"} decoding="async" className="aspect-[4/3] h-auto w-full object-cover transition duration-700 motion-safe:group-hover:scale-[1.04]" /> : <div className="flex aspect-[4/3] items-center justify-center text-[9px] font-mono tracking-[.18em] text-zinc-600">IMAGE COMING SOON</div>}
                <span className="absolute left-3 top-3 border border-cyan-300/20 bg-black/75 px-2 py-1 text-[8px] font-mono tracking-[.15em] text-cyan-100">SHOPIFY LIVE</span>
                <span className="absolute right-3 bottom-3 font-mono text-[8px] tracking-[.16em] text-white/45">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <div className="flex flex-1 flex-col p-5"><h3 className="line-clamp-2 text-base font-medium leading-6 text-zinc-100 group-hover:text-white">{listing.title}</h3>
                {listing.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-500">{listing.description}</p> : null}
                <div className="mt-5 flex flex-wrap gap-2"><span className="border border-white/10 px-2 py-1 text-[7px] font-mono tracking-[.14em] text-zinc-500">GATE PASSED</span><span className="border border-white/10 px-2 py-1 text-[7px] font-mono tracking-[.14em] text-zinc-500">{listing.inventory} IN STOCK</span><span className="border border-white/10 px-2 py-1 text-[7px] font-mono tracking-[.14em] text-zinc-500">TRACKABLE</span></div>
                <div className="mt-auto flex items-end justify-between gap-3 border-t border-white/8 pt-5 mt-6"><div><span className="block font-mono text-[7px] tracking-[.16em] text-zinc-600">PRICE</span><span className="mt-1 block text-lg text-zinc-100">{formatMoney(listing.sellingPrice, listing.currency)}</span></div><span className="text-[9px] font-mono tracking-[.12em] text-zinc-500 group-hover:text-cyan-200">DETAIL ↗</span></div>
              </div>
            </Link>)}
          </div>
        </section>
      )}
    </main>
  );
}
