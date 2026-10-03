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
        ? "店舗データを読み込めません。時間をおいてもう一度お試しください。"
        : caught instanceof Error
          ? caught.message
          : "店舗を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby="shop-heading" className="relative overflow-hidden border border-white/10 bg-zinc-950/70 px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-300/80">
            <span>TRACER selection</span>
            <span aria-hidden="true">/</span>
            <span>{listings.length} items</span>
          </div>
          <div className="mt-5 flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <h1 id="shop-heading" className="text-4xl font-medium tracking-tight text-zinc-50 sm:text-5xl">
                いま、試してみたいもの。
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                市場で注目され、商品としての条件まで確認できたものだけをセレクト。
                「気になる」を、そのまま次の一歩へ。
              </p>
            </div>
            <Link
              href="/bestsellers"
              className="inline-flex w-fit items-center border border-cyan-300/25 bg-cyan-300/5 px-4 py-3 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              選定の背景を見る <span className="ml-2" aria-hidden="true">→</span>
            </Link>
          </div>

          <div className="mt-9 grid max-w-4xl gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-3" aria-label="TRACERで得られること">
            {[
              ["迷いを減らす", "なぜ候補になったかを確認できる"],
              ["確認を揃える", "商品・仕入・価格・配送を順番に見る"],
              ["次へ進める", "条件が揃った商品だけを試せる"],
            ].map(([title, copy]) => (
              <div key={title} className="bg-white/[0.025] px-4 py-4 sm:px-5">
                <p className="text-xs font-medium text-zinc-200">{title}</p>
                <p className="mt-1 text-[11px] leading-5 text-zinc-600">{copy}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap gap-2" aria-label="商品選定の特徴">
            {[
              "市場シグナルを確認",
              "商品同一性を確認",
              "仕入・利益条件を確認",
            ].map((label) => (
              <span key={label} className="border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-zinc-400">
                <span className="mr-2 text-cyan-300" aria-hidden="true">✓</span>{label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {error ? (
        <div role="alert" className="mt-8 border border-amber-400/20 bg-amber-400/5 px-5 py-4 text-sm text-amber-200">
          {error}
        </div>
      ) : null}

      {listings.length === 0 && !error ? (
        <section className="mt-8 border border-dashed border-white/10 px-6 py-16 text-center sm:px-12" aria-labelledby="empty-heading">
          <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-300/70">Next selection in progress</p>
          <h2 id="empty-heading" className="mt-4 text-2xl font-medium text-zinc-100">
            次に「試したい」と思える商品を探しています。
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-zinc-500">
            TRACERは、条件を満たさない商品を無理に並べません。市場の変化、商品同一性、仕入条件、利益条件をAI循環で再確認し、公開できる商品だけを追加します。
          </p>
          <div className="mx-auto mt-8 grid max-w-2xl gap-px overflow-hidden border border-white/8 bg-white/8 text-left sm:grid-cols-3">
            {[
              ["市場", "いま何が動いているか"],
              ["商機", "なぜ候補なのか"],
              ["確認", "何が足りないのか"],
            ].map(([title, copy]) => (
              <div key={title} className="bg-white/[0.025] p-4">
                <p className="text-xs font-medium text-zinc-200">{title}</p>
                <p className="mt-1 text-[11px] leading-5 text-zinc-600">{copy}</p>
              </div>
            ))}
          </div>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              href="/bestsellers"
              className="border border-cyan-300/30 bg-cyan-300/5 px-5 py-3 text-xs text-cyan-100 transition hover:bg-cyan-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              売れ筋を見る →
            </Link>
            <Link
              href="/intelligence"
              className="border border-white/10 px-5 py-3 text-xs text-zinc-300 transition hover:border-white/20 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              商機を見る →
            </Link>
          </div>
        </section>
      ) : (
        <section className="mt-8" aria-labelledby="catalog-heading">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">Curated catalog</p>
              <h2 id="catalog-heading" className="mt-1 text-lg text-zinc-100">セレクト商品</h2>
            </div>
            <p className="text-xs text-zinc-600" aria-live="polite">{listings.length}件</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listings.map((listing) => (
              <Link
                key={listing.id}
                href={`/shop/${listing.slug}`}
                className="group flex h-full flex-col overflow-hidden border border-white/10 bg-zinc-950/60 transition duration-300 hover:-translate-y-1 hover:border-cyan-300/30 hover:bg-zinc-900/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                <div className="relative overflow-hidden bg-zinc-900">
                  {listing.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={listing.imageUrl}
                      alt={listing.title}
                      loading="lazy"
                      className="aspect-[4/3] h-auto w-full object-cover transition duration-500 motion-safe:group-hover:scale-[1.035]"
                    />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center border-b border-white/8 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-700">
                      Image coming soon
                    </div>
                  )}
                  <span className="absolute left-3 top-3 border border-white/10 bg-black/60 px-2 py-1 text-[9px] font-mono uppercase tracking-[0.16em] text-zinc-300 backdrop-blur">
                    Selected
                  </span>
                </div>

                <div className="flex flex-1 flex-col p-5">
                  <h3 className="line-clamp-2 text-base font-medium leading-6 text-zinc-100 transition group-hover:text-white">
                    {listing.title}
                  </h3>
                  {listing.description ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-500">{listing.description}</p>
                  ) : null}
                  <div className="mt-auto pt-5">
                    <div className="flex items-end justify-between gap-3 border-t border-white/8 pt-4">
                      <div>
                        <p className="text-[9px] font-mono uppercase tracking-[0.16em] text-zinc-600">Price</p>
                        <p className="mt-1 text-lg font-medium tracking-tight text-zinc-100">
                          {formatMoney(listing.sellingPrice, listing.currency)}
                        </p>
                      </div>
                      <span className="inline-flex items-center border border-white/10 px-3 py-2 text-[10px] font-medium text-zinc-400 transition group-hover:border-cyan-300/30 group-hover:text-cyan-200">
                        詳細を見る <span className="ml-1.5" aria-hidden="true">→</span>
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
