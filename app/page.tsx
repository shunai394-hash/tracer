import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "TRACER — オンラインストア",
  description: "商品を探して、内容を確認して、購入できるオンラインストア。",
};

export default async function HomePage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let error: string | null = null;
  try {
    listings = await listPublishedShopListings();
  } catch (caught) {
    error = caught instanceof SupabaseConfigError
      ? "商品を読み込めません。時間をおいてもう一度お試しください。"
      : caught instanceof Error
        ? caught.message
        : "商品を読み込めませんでした。";
  }

  return (
    <main className="min-h-screen bg-white">
      <section className="border-b border-neutral-200 bg-neutral-50">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
          <p className="text-sm text-neutral-500">TRACER ONLINE STORE</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">商品を探す</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-neutral-600">
            商品情報と販売条件を確認した商品を掲載しています。
          </p>
          <Link href="/shop" className="mt-5 inline-flex rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-700">
            すべての商品を見る
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-10 sm:py-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">商品一覧</h2>
            <p className="mt-1 text-sm text-neutral-500">販売条件を確認済みの商品</p>
          </div>
          <Link href="/shop" className="text-sm text-neutral-700 underline underline-offset-4">一覧を見る</Link>
        </div>

        {error ? (
          <p role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        ) : listings.length === 0 ? (
          <div className="mt-6 rounded-lg border border-neutral-200 p-6">
            <h3 className="font-medium">現在、販売できる商品を確認中です。</h3>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              仕入れ先の在庫、商品バリエーション、原価、発注可否を確認できた商品から掲載します。
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
            {listings.slice(0, 8).map((listing) => (
              <Link key={listing.id} href={`/shop/${listing.slug}`} className="overflow-hidden rounded-lg border border-neutral-200 bg-white transition hover:border-neutral-400">
                {listing.imageUrl ? (
                  <img src={listing.imageUrl} alt={listing.title} loading="lazy" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-neutral-100 text-sm text-neutral-400">画像準備中</div>
                )}
                <div className="p-3 sm:p-4">
                  <h3 className="line-clamp-2 text-sm font-medium leading-5">{listing.title}</h3>
                  <p className="mt-3 text-base font-semibold">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
