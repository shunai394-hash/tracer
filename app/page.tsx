import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { SupabaseConfigError } from "@/lib/supabase/server";
import { ProductCard } from "@/components/product-card";
import { STOREFRONT_CATEGORIES, STOREFRONT_IMAGES, categoryOf, pickDistinct } from "@/lib/shop/storefront-display";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "TRACER — 毎日を、少しだけ上品に。",
  description: "バッグ、ヘアアクセサリー、メイク小物。いつもの装いに寄り添うアイテムを集めたセレクトショップ。",
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

  const byCategory = new Map(STOREFRONT_CATEGORIES.map((category) => [category.slug, listings.filter((listing) => categoryOf(listing.title) === category.slug)]));
  const categories = STOREFRONT_CATEGORIES
    .map((category) => ({ ...category, items: byCategory.get(category.slug) ?? [] }))
    .filter((category) => category.items.length > 0);
  // Pickup alternates categories so the first row is not only bags.
  const perCategory = categories.map((category) => pickDistinct(category.items, 8));
  const pickup = Array.from({ length: 8 }, (_, round) => perCategory.map((items) => items[round]))
    .flat()
    .filter((listing): listing is NonNullable<typeof listing> => Boolean(listing))
    .slice(0, 8);

  return (
    <main className="min-h-screen bg-[#FBF6F1] text-[#3B241A]">
      <section className="relative overflow-hidden">
        <picture>
          <source media="(min-width: 768px)" srcSet={STOREFRONT_IMAGES.heroWide} />
          <img src={STOREFRONT_IMAGES.heroTall} alt="窓辺で小ぶりのバッグを持つ女性" fetchPriority="high" className="h-[78vh] max-h-[760px] min-h-[520px] w-full object-cover object-bottom md:h-[70vh] md:object-center" />
        </picture>
        <div className="absolute inset-0 bg-gradient-to-b from-[#FBF6F1]/85 via-[#FBF6F1]/30 to-transparent md:bg-gradient-to-r md:from-[#FBF6F1]/90 md:via-[#FBF6F1]/40 md:to-transparent" />
        <div className="absolute inset-0 mx-auto flex max-w-6xl flex-col justify-start px-6 pt-12 md:justify-center md:pt-0">
          <p className="text-xs tracking-[0.3em] text-[#9A6B5B]">TRACER SELECT</p>
          <h1 className="mt-4 font-serif text-[34px] leading-tight sm:text-5xl">毎日を、<br />少しだけ上品に。</h1>
          <p className="mt-5 max-w-sm text-sm leading-7 text-[#5C4035]">
            バッグ、ヘアアクセサリー、メイク小物。<br />いつもの装いに寄り添うアイテムを集めました。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/shop" className="rounded-full bg-[#3B241A] px-7 py-3 text-sm font-medium text-white transition hover:bg-[#5C4035]">すべての商品を見る</Link>
            <Link href="/shop?cat=bags" className="rounded-full border border-[#3B241A]/30 bg-white/70 px-7 py-3 text-sm font-medium backdrop-blur transition hover:bg-white">バッグを見る</Link>
          </div>
        </div>
      </section>

      <section aria-label="お買い物のご案内" className="border-y border-[#EADBD3] bg-white/60">
        <ul className="mx-auto grid max-w-6xl grid-cols-1 gap-2 px-6 py-4 text-center text-xs text-[#5C4035] sm:grid-cols-3 sm:text-sm">
          <li>価格はすべて税込表示</li>
          <li>在庫を確認できた商品だけを掲載</li>
          <li>配送・返品条件は各商品ページでご確認いただけます</li>
        </ul>
      </section>

      {error ? (
        <div className="mx-auto max-w-6xl px-6 py-12">
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        </div>
      ) : listings.length === 0 ? (
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="rounded-2xl bg-white p-8 text-center">
            <h2 className="font-serif text-xl">ただいま商品を準備しています。</h2>
            <p className="mt-3 text-sm leading-6 text-[#5C4035]">新しいアイテムを順次追加します。どうぞ楽しみにお待ちください。</p>
          </div>
        </div>
      ) : (
        <>
          <section className="mx-auto max-w-6xl px-6 pt-14 sm:pt-20">
            <SectionHeading eyebrow="CATEGORY" title="カテゴリから探す" />
            <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
              {categories.map((category) => {
                const cover = category.items.find((item) => item.imageUrl);
                return (
                  <Link key={category.slug} href={`/shop?cat=${category.slug}`} className="group relative overflow-hidden rounded-2xl bg-[#F4ECE6]">
                    {cover?.imageUrl ? <img src={cover.imageUrl} alt="" loading="lazy" className="aspect-[4/5] w-full object-cover transition duration-500 group-hover:scale-[1.04]" /> : <div className="aspect-[4/5]" />}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#3B241A]/75 to-transparent p-4 pt-12 text-white">
                      <p className="font-serif text-lg">{category.label}</p>
                      <p className="mt-1 text-[11px] leading-4 text-white/85">{category.lead}</p>
                      <p className="mt-2 text-[11px] text-white/80">{category.items.length}点 →</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="mx-auto max-w-6xl px-6 pt-16 sm:pt-24">
            <SectionHeading eyebrow="PICK UP" title="ピックアップ" link={{ href: "/shop", label: "すべて見る" }} />
            <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
              {pickup.map((listing, index) => <ProductCard key={listing.id} listing={listing} priority={index < 4} />)}
            </div>
          </section>

          <section className="mt-16 bg-[#F6E2E0]/60 sm:mt-24">
            <div className="mx-auto grid max-w-6xl items-center gap-8 px-6 py-14 md:grid-cols-2 md:gap-14 md:py-20">
              <img src={STOREFRONT_IMAGES.lifestyle} alt="リネンの上に置かれたピンクのバッグ、ヘアクリップ、メイクブラシ" loading="lazy" className="aspect-[4/3] w-full rounded-2xl object-cover" />
              <div>
                <p className="text-xs tracking-[0.3em] text-[#9A6B5B]">OUR STORY</p>
                <h2 className="mt-3 font-serif text-2xl leading-snug sm:text-3xl">いつもの毎日に、<br />小さなときめきを。</h2>
                <p className="mt-5 text-sm leading-7 text-[#5C4035]">
                  通勤にも休日にも合わせやすいバッグや、まとめ髪を上品に仕上げるヘアアクセサリーなど、毎日使えるアイテムを選んでいます。価格と在庫を確認できた商品だけを掲載しています。
                </p>
                <Link href="/shop" className="mt-7 inline-block rounded-full border border-[#3B241A]/30 px-7 py-3 text-sm font-medium transition hover:bg-white">商品一覧へ</Link>
              </div>
            </div>
          </section>

          {categories.filter((category) => category.slug !== "other").map((category) => (
            <section key={category.slug} className="mx-auto max-w-6xl px-6 pt-16 sm:pt-20">
              <SectionHeading eyebrow={category.slug.toUpperCase()} title={category.label} link={{ href: `/shop?cat=${category.slug}`, label: `${category.label}をすべて見る` }} />
              <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-4 sm:gap-x-5">
                {pickDistinct(category.items, 4).map((listing) => <ProductCard key={listing.id} listing={listing} />)}
              </div>
            </section>
          ))}
          <div className="pb-20" />
        </>
      )}
    </main>
  );
}

function SectionHeading({ eyebrow, title, link }: { eyebrow: string; title: string; link?: { href: string; label: string } }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">{eyebrow}</p>
        <h2 className="mt-2 font-serif text-2xl sm:text-[28px]">{title}</h2>
      </div>
      {link ? <Link href={link.href} className="shrink-0 text-sm text-[#5C4035] underline-offset-4 hover:underline">{link.label} →</Link> : null}
    </div>
  );
}
