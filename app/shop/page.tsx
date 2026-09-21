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
          : "店舗を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Sales test store</p>
      <h1 className="mt-3 text-3xl text-zinc-50">販売テスト店舗</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        市場ランキングで確認できた商品のうち、同一商品の無在庫仕入と利益計算が成立したものだけを公開します。推測で埋めた商品はありません。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {listings.length === 0 && !error ? (
        <p className="mt-10 text-sm text-zinc-500">
          いま公開できる販売テスト商品はありません。売れ筋の識別子と仕入条件が揃うまで待ちます。
        </p>
      ) : (
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <Link
              key={listing.id}
              href={`/shop/${listing.slug}`}
              className="border border-white/10 p-4 hover:border-cyan-400/40"
            >
              {listing.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={listing.imageUrl}
                  alt={listing.title}
                  className="h-48 w-full object-cover"
                />
              ) : (
                <div className="flex h-48 items-center justify-center border border-dashed border-white/10 text-xs text-zinc-600">
                  No image
                </div>
              )}
              <h2 className="mt-3 text-lg text-zinc-100">{listing.title}</h2>
              <p className="mt-2 text-sm text-zinc-300">
                {formatMoney(listing.sellingPrice, listing.currency)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
