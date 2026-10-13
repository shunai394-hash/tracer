import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "販売商品 — TRACER",
  description: "仕入れと販売の条件を確認した商品一覧。",
};

export default async function ShopPage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let error: string | null = null;

  try {
    listings = await listPublishedShopListings();
  } catch (caught) {
    error = caught instanceof SupabaseConfigError
      ? "店舗データを読み込めません。設定を確認してください。"
      : caught instanceof Error
        ? caught.message
        : "商品を読み込めませんでした。";
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="text-xl font-semibold tracking-tight">TRACER</Link>
          <Link href="/intelligence" className="text-sm underline underline-offset-4">商品候補を調べる</Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
        <p className="text-sm text-neutral-500">販売商品</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">販売できる商品</h1>
          <p className="text-sm text-neutral-500">{listings.length}件</p>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">
          仕入れ先との商品・バリエーション照合、在庫、原価、発注可否を確認した商品を掲載します。
          Amazon・楽天市場・Yahoo!ショッピングのランキング観測データは、販売商品として表示しません。
        </p>

        {error ? (
          <p role="alert" className="mt-8 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        ) : listings.length === 0 ? (
          <div className="mt-8 rounded-lg border border-neutral-200 p-8">
            <h2 className="font-semibold">現在、掲載条件を満たした商品はありません。</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
              ランキング商品や未確認の仕入れ候補で件数を埋めず、仕入れ可能性と利益を確認できた商品から掲載します。
            </p>
            <Link href="/intelligence" className="mt-5 inline-flex rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700">
              商品候補を調べる
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listings.map((listing) => (
              <Link key={listing.id} href={`/shop/${listing.slug}`} className="group overflow-hidden rounded-lg border border-neutral-200 bg-white transition hover:border-neutral-400">
                {listing.imageUrl ? (
                  <img src={listing.imageUrl} alt={listing.title} loading="lazy" className="aspect-square w-full bg-neutral-100 object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-neutral-100 text-sm text-neutral-400">画像準備中</div>
                )}
                <div className="p-4">
                  <h2 className="line-clamp-2 font-medium group-hover:underline">{listing.title}</h2>
                  {listing.description ? <p className="mt-2 line-clamp-2 text-sm leading-5 text-neutral-500">{listing.description}</p> : null}
                  <p className="mt-4 text-lg font-semibold">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                  <p className="mt-1 text-xs text-neutral-500">在庫 {listing.inventory} · 販売条件確認済み</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
