import Link from "next/link";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { listPublishedShopListings } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "商品一覧 — TRACER",
  description: "販売中の商品と、販売準備中の商品候補を分けて掲載します。",
};

type CatalogCandidate = {
  product_id: string;
  normalized_title: string;
  brand_name: string | null;
  category: string | null;
  image_url: string | null;
  current_price: number | string | null;
  currency: string | null;
  status: string | null;
};

function candidateImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export default async function ShopPage() {
  let listings: Awaited<ReturnType<typeof listPublishedShopListings>> = [];
  let candidates: CatalogCandidate[] = [];
  let error: string | null = null;
  let candidateError: string | null = null;

  try {
    listings = await listPublishedShopListings();
  } catch (caught) {
    error = caught instanceof SupabaseConfigError
      ? "販売中の商品を読み込めません。時間をおいてもう一度お試しください。"
      : caught instanceof Error
        ? caught.message
        : "販売中の商品を読み込めませんでした。";
  }

  try {
    const db = createSupabaseAdminClient();
    const { data, error: queryError } = await db
      .from("product_intelligence")
      .select("product_id,normalized_title,brand_name,category,image_url,current_price,currency,status")
      .neq("status", "rejected")
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (queryError) throw new Error(queryError.message);

    const liveProductIds = new Set(listings.map((listing) => listing.productId));
    candidates = ((data ?? []) as CatalogCandidate[])
      .filter((item) => item.product_id && item.normalized_title?.trim())
      .filter((item) => !liveProductIds.has(item.product_id))
      .filter((item) => !/^(unknown product|test product|商品名不明|不明)$/i.test(item.normalized_title.trim()));
  } catch (caught) {
    candidateError = caught instanceof Error ? caught.message : "商品候補を読み込めませんでした。";
  }

  return (
    <main className="mx-auto min-h-[70vh] w-full max-w-6xl px-5 py-8 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 pb-5">
        <div>
          <p className="text-sm text-neutral-500">TRACER ONLINE STORE</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">商品一覧</h1>
          <p className="mt-2 text-sm text-neutral-600">販売中の商品と、販売準備中の商品候補を分けて表示します。</p>
        </div>
        <p className="text-sm text-neutral-500">{listings.length}件 販売中</p>
      </div>

      {error ? (
        <p role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
      ) : null}

      <section aria-labelledby="available-heading" className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 pb-3">
          <div>
            <h2 id="available-heading" className="text-lg font-semibold">販売中</h2>
            <p className="mt-1 text-sm text-neutral-500">在庫・販売条件・Shopify同期を確認できた商品</p>
          </div>
          <p className="text-sm text-neutral-500">{listings.length}件</p>
        </div>

        {listings.length === 0 ? (
          <div className="mt-4 rounded-lg border border-neutral-200 p-6">
            <h3 className="font-semibold">現在、購入できる商品はありません。</h3>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              商品候補は下に表示します。販売中の表示や購入ボタンは、実際の在庫・価格・仕入れ条件を確認できた商品に限ります。
            </p>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
            {listings.map((listing) => (
              <Link key={listing.id} href={`/shop/${listing.slug}`} className="overflow-hidden rounded-lg border border-neutral-200 bg-white transition hover:border-neutral-400">
                {listing.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={listing.imageUrl} alt={listing.title} loading="lazy" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-neutral-100 text-sm text-neutral-400">画像準備中</div>
                )}
                <div className="p-3 sm:p-4">
                  <h3 className="line-clamp-2 text-sm font-medium leading-5">{listing.title}</h3>
                  <p className="mt-3 text-base font-semibold">{formatMoney(listing.sellingPrice, listing.currency)}</p>
                  <p className="mt-1 text-xs text-neutral-500">在庫 {listing.inventory}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="candidate-heading" className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 pb-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Catalog candidates</p>
            <h2 id="candidate-heading" className="mt-1 text-lg font-semibold">販売準備中の商品候補</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
              商品棚から候補を消さずに表示します。ここにある商品はまだ購入できません。仕入先・在庫・価格・配送条件の確認後に、販売中へ切り替えます。
            </p>
          </div>
          <p className="text-sm text-neutral-500">{candidates.length}件 候補</p>
        </div>

        {candidateError ? (
          <p role="alert" className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            商品候補を読み込めませんでした。{candidateError}
          </p>
        ) : candidates.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-neutral-300 p-6">
            <h3 className="font-semibold">商品候補がありません。</h3>
            <p className="mt-2 text-sm text-neutral-600">商品発見・カタログ登録の処理結果を確認してください。</p>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
            {candidates.map((candidate) => {
              const imageUrl = candidateImageUrl(candidate.image_url);
              return (
                <article key={candidate.product_id} className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl} alt={candidate.normalized_title} loading="lazy" className="aspect-square w-full object-cover" />
                  ) : (
                    <div className="flex aspect-square items-center justify-center bg-neutral-100 px-4 text-center text-sm text-neutral-400">商品画像なし</div>
                  )}
                  <div className="p-3 sm:p-4">
                    <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800">販売準備中・購入不可</span>
                    <h3 className="mt-3 line-clamp-3 text-sm font-medium leading-5 text-neutral-900">{candidate.normalized_title}</h3>
                    {candidate.brand_name || candidate.category ? (
                      <p className="mt-2 line-clamp-1 text-xs text-neutral-500">{[candidate.brand_name, candidate.category].filter(Boolean).join(" · ")}</p>
                    ) : null}
                    <p className="mt-3 text-xs text-neutral-500">
                      {candidate.current_price !== null && candidate.currency
                        ? `参考情報: ${candidate.currency} ${candidate.current_price}`
                        : "販売価格未確定"}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">仕入先・在庫・配送条件を確認中</p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
