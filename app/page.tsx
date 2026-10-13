import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "TRACER — 販売できる商品を探す",
  description: "仕入れ条件を確認し、販売できる商品だけを扱うTRACER。",
};

export default async function HomePage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let error: string | null = null;

  try {
    listings = await listPublishedShopListings();
  } catch (caught) {
    error = caught instanceof SupabaseConfigError
      ? "商品データを読み込めません。設定を確認してください。"
      : caught instanceof Error
        ? caught.message
        : "商品データを読み込めませんでした。";
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="text-xl font-semibold tracking-tight">TRACER</Link>
          <nav className="flex items-center gap-5 text-sm">
            <Link href="/shop" className="hover:underline">販売商品</Link>
            <Link href="/intelligence" className="hover:underline">商品候補を調べる</Link>
          </nav>
        </div>
      </header>

      <section className="border-b border-neutral-200 bg-neutral-50">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:py-20">
          <p className="text-sm font-medium text-neutral-500">商品選定・仕入れ確認・販売管理</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-5xl">
            売れる可能性だけでなく、<br className="hidden sm:block" />実際に販売できる商品を。
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-neutral-600">
            仕入れ先、在庫、原価、販売価格を確認。条件を満たした商品だけを販売一覧に表示します。
            市場ランキングの商品を、そのまま販売商品として扱うことはありません。
          </p>
          <Link href="/shop" className="mt-7 inline-flex items-center rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-700">
            販売できる商品を見る
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">販売商品</h2>
            <p className="mt-1 text-sm text-neutral-500">販売条件を通過した商品のみ掲載</p>
          </div>
          <Link href="/shop" className="text-sm underline underline-offset-4">商品一覧を見る</Link>
        </div>

        {error ? (
          <p role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        ) : listings.length === 0 ? (
          <div className="mt-6 rounded-lg border border-neutral-200 p-8">
            <h3 className="font-medium">現在、掲載条件を満たした商品はありません。</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
              件数を増やすために、未確認の商品や市場ランキングを販売商品として表示することはしません。
              仕入れ先の商品ID・バリエーション・実在庫・原価・発注可否を確認してから掲載します。
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {listings.slice(0, 8).map((listing) => (
              <Link key={listing.id} href={`/shop/${listing.slug}`} className="group overflow-hidden rounded-lg border border-neutral-200 bg-white transition hover:border-neutral-400">
                {listing.imageUrl ? (
                  <img src={listing.imageUrl} alt={listing.title} loading="lazy" className="aspect-square w-full bg-neutral-100 object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-neutral-100 text-sm text-neutral-400">画像準備中</div>
                )}
                <div className="p-4">
                  <h3 className="line-clamp-2 font-medium group-hover:underline">{listing.title}</h3>
                  {listing.description ? <p className="mt-2 line-clamp-2 text-sm leading-5 text-neutral-500">{listing.description}</p> : null}
                  <p className="mt-4 text-lg font-semibold">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="border-t border-neutral-200">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 px-5 py-6 text-sm text-neutral-500">
          <span>TRACER</span>
          <span>未確認データを販売実績や仕入れ可能性として表示しません。</span>
        </div>
      </footer>
    </main>
  );
}
