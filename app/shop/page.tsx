import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ShopPage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let error: string | null = null;

  try {
    listings = await listPublishedShopListings();
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? "店舗データを読めません。"
        : caught instanceof Error
          ? caught.message
          : "店舗を読み込めませんでした.";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
      <div className="border-b border-white/8 pb-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">Sales test store</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="text-3xl text-zinc-50">販売テスト店舗</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
              市場ランキングで確認できた商品のうち、同一商品の無在庫仕入と利益計算が成立したものだけを公開。
              推測で埋めた商品はありません。
            </p>
          </div>
          <Link href="/intelligence" className="border border-cyan-400/25 px-4 py-3 text-xs text-cyan-200 hover:bg-cyan-400/10">
            商機を見る →
          </Link>
        </div>
      </div>

      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}

      {listings.length === 0 && !error ? (
        <div className="mt-10 border border-dashed border-cyan-500/20 p-12 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">TEST QUEUE EMPTY</p>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-zinc-400">
            いま公開できる販売テスト商品はありません。売れ筋の識別子・仕入条件・利益計算が揃った商品だけがここへ進みます。
          </p>
          <Link href="/bestsellers" className="mt-6 inline-block text-xs text-cyan-300 hover:text-cyan-100">
            売れ筋観測を見る →
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <Link
              key={listing.id}
              href={`/shop/${listing.slug}`}
              className="group overflow-hidden border border-white/10 bg-zinc-950/50 hover:border-cyan-400/35"
            >
              {listing.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={listing.imageUrl}
                  alt={listing.title}
                  className="h-52 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                />
              ) : (
                <div className="flex h-52 items-center justify-center border-b border-white/8 text-xs uppercase tracking-[0.18em] text-zinc-700">
                  No image
                </div>
              )}
              <div className="p-5">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-400/70">Sales test</p>
                <h2 className="mt-2 line-clamp-2 text-lg leading-7 text-zinc-100">{listing.title}</h2>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-base text-zinc-200">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                  <span className="text-xs text-zinc-600 group-hover:text-cyan-300">View →</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
