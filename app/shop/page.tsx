import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "商品一覧 — TRACER",
  description: "販売条件を確認した商品一覧。",
};

export default async function ShopPage() {
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
    <main className="mx-auto min-h-[70vh] w-full max-w-6xl px-5 py-8 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 pb-5">
        <div>
          <p className="text-sm text-neutral-500">TRACER ONLINE STORE</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">商品一覧</h1>
        </div>
        <p className="text-sm text-neutral-500">{listings.length}件</p>
      </div>

      {error ? (
        <p role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
      ) : listings.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 p-6">
          <h2 className="font-semibold">現在、販売できる商品はありません。</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-600">
            仕入れ先の在庫、商品バリエーション、原価、発注可否を確認できた商品から掲載します。
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
          {listings.map((listing) => (
            <Link key={listing.id} href={`/shop/${listing.id}`} className="overflow-hidden rounded-lg border border-neutral-200 bg-white transition hover:border-neutral-400">
              {listing.imageUrl ? (
                <img src={listing.imageUrl} alt={listing.title} loading="lazy" className="aspect-square w-full object-cover" />
              ) : (
                <div className="flex aspect-square items-center justify-center bg-neutral-100 text-sm text-neutral-400">画像準備中</div>
              )}
              <div className="p-3 sm:p-4">
                <h2 className="line-clamp-2 text-sm font-medium leading-5">{listing.title}</h2>
                {listing.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-500">{listing.description}</p> : null}
                <p className="mt-3 text-base font-semibold">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                <p className="mt-1 text-xs text-neutral-500">{listing.manualInventory ? `在庫 ${listing.inventory}` : "在庫あり"}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
