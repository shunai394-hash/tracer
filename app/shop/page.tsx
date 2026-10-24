import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { SupabaseConfigError } from "@/lib/supabase/server";
import { ProductCard } from "@/components/product-card";
import { STOREFRONT_CATEGORIES, categoryOf } from "@/lib/shop/storefront-display";

export const dynamic = "force-dynamic";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\\/$/, "");

const CATEGORY_SEO: Record<string, { title: string; description: string }> = {
  bags: { title: "バッグ｜ハンドバッグ・ショルダーバッグ", description: "毎日の通勤や休日のお出かけに合わせやすいハンドバッグ・ショルダーバッグをチェック。価格と在庫を商品ページで確認できます。" },
  hair: { title: "ヘアアクセサリー｜ヘアクリップ・まとめ髪アイテム", description: "まとめ髪や日々のスタイリングに使えるヘアクリップなどのヘアアクセサリー。商品ごとの価格と在庫をご確認いただけます。" },
  makeup: { title: "メイク小物｜ブラシ収納・お手入れ用品", description: "メイクブラシの収納やお手入れに役立つメイク小物をチェック。各商品の仕様・価格・在庫をご確認いただけます。" },
  other: { title: "ライフスタイル小物", description: "日々の暮らしに取り入れやすい小物をセレクト。商品ごとの仕様・価格・在庫をご確認いただけます。" },
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const cat = param(query.cat);
  const q = param(query.q);
  const sort = param(query.sort);
  const page = param(query.page);
  const category = STOREFRONT_CATEGORIES.find((item) => item.slug === cat);
  const seo = category ? CATEGORY_SEO[category.slug] : null;
  const canonical = category ? `/shop?cat=${encodeURIComponent(category.slug)}` : "/shop";
  const title = seo?.title ?? "商品一覧｜バッグ・ヘアアクセサリー・メイク小物";
  const description = seo?.description ?? "バッグ、ヘアアクセサリー、メイク小物など、日々の装いに取り入れやすいアイテムを探せるTRACERのセレクトショップ。商品ごとの価格と在庫をご確認いただけます。";
  const isFilteredSearch = Boolean(q || sort || page);
  return {
    title,
    description,
    alternates: { canonical },
    ...(isFilteredSearch ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "website" as const,
      locale: "ja_JP",
      siteName: "TRACER",
      title,
      description,
      url: new URL(canonical, SITE_URL).toString(),
    },
    twitter: { card: "summary_large_image" as const, title, description },
  };
}

const SORTS = [
  { value: "", label: "おすすめ順" },
  { value: "price_asc", label: "価格の安い順" },
  { value: "price_desc", label: "価格の高い順" },
] as const;

function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const cat = param(query.cat);
  const q = param(query.q);
  const sort = param(query.sort);
  const requestedPage = Math.max(1, Math.floor(Number(param(query.page)) || 1));

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

  const activeCategory = STOREFRONT_CATEGORIES.find((category) => category.slug === cat) ?? null;
  const counts = new Map<string, number>();
  for (const listing of listings) counts.set(categoryOf(listing.title), (counts.get(categoryOf(listing.title)) ?? 0) + 1);
  const needle = q.normalize("NFKC").toLocaleLowerCase();
  let shown = listings
    .filter((listing) => !activeCategory || categoryOf(listing.title) === activeCategory.slug)
    .filter((listing) => !needle || `${listing.title} ${listing.description ?? ""}`.normalize("NFKC").toLocaleLowerCase().includes(needle));
  if (sort === "price_asc") shown = [...shown].sort((a, b) => (a.sellingPrice ?? 0) - (b.sellingPrice ?? 0));
  if (sort === "price_desc") shown = [...shown].sort((a, b) => (b.sellingPrice ?? 0) - (a.sellingPrice ?? 0));

  // Exact duplicate supplier variants are removed in listPublishedShopListings.
  // Distinct variants must not be hidden merely because their titles normalize to one family.
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const pageItems = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const href = (next: { cat?: string; sort?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nextCat = next.cat ?? cat;
    const nextSort = next.sort ?? sort;
    if (nextCat) params.set("cat", nextCat);
    if (q) params.set("q", q);
    if (nextSort) params.set("sort", nextSort);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const text = params.toString();
    return text ? `/shop?${text}` : "/shop";
  };

  return (
    <main className="min-h-[70vh] w-full bg-[#FBF6F1] text-[#3B241A]">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:py-12">
        <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">TRACER ONLINE STORE</p>
        <h1 className="mt-2 font-serif text-3xl">{activeCategory ? activeCategory.label : "すべての商品"}</h1>

        <form action="/shop" className="mt-6 flex max-w-xl gap-2">
          {activeCategory ? <input type="hidden" name="cat" value={activeCategory.slug} /> : null}
          {sort ? <input type="hidden" name="sort" value={sort} /> : null}
          <label htmlFor="shop-search" className="sr-only">商品を検索</label>
          <input id="shop-search" name="q" defaultValue={q} placeholder="商品名で検索（例：ショルダー、ピンク）" className="min-w-0 flex-1 rounded-full border border-[#EADBD3] bg-white px-5 py-2.5 text-sm outline-none focus:border-[#9A6B5B]" />
          <button type="submit" className="rounded-full bg-[#3B241A] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#5C4035]">検索</button>
        </form>

        <nav aria-label="カテゴリ" className="mt-6 flex flex-wrap gap-2">
          <Link href={href({ cat: "" })} className={chip(!activeCategory)}>すべて <span className="opacity-70">{listings.length}</span></Link>
          {STOREFRONT_CATEGORIES.filter((category) => counts.get(category.slug)).map((category) => (
            <Link key={category.slug} href={href({ cat: category.slug })} className={chip(activeCategory?.slug === category.slug)}>
              {category.label} <span className="opacity-70">{counts.get(category.slug)}</span>
            </Link>
          ))}
        </nav>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-[#EADBD3] pb-4">
          <div>
            <p className="text-sm text-[#5C4035]">{error ? "読込エラー" : `${shown.length}件表示${q ? `（「${q}」の検索結果）` : ""}`}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {SORTS.map((option) => (
              <Link key={option.value} href={href({ sort: option.value })} className={sort === option.value ? "font-semibold underline underline-offset-4" : "text-[#5C4035] hover:underline"}>
                {option.label}
              </Link>
            ))}
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        ) : shown.length === 0 ? (
          <div className="mt-8 rounded-2xl bg-white p-6">
            <h2 className="font-semibold">{listings.length === 0 ? "現在、販売できる商品はありません。" : "条件に合う商品が見つかりませんでした。"}</h2>
            <p className="mt-2 text-sm leading-6 text-[#5C4035]">
              {listings.length === 0
                ? "仕入れ先の在庫、商品バリエーション、原価、発注可否を確認できた商品から掲載します。"
                : "キーワードやカテゴリを変えてお試しください。"}
            </p>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
            {pageItems.map((listing, index) => <ProductCard key={listing.id} listing={listing} priority={index < 4} />)}
          </div>
        )}

        {!error && pageCount > 1 ? (
          <nav aria-label="ページ" className="mt-12 flex items-center justify-center gap-4 text-sm">
            {page > 1 ? <Link href={href({ page: page - 1 })} className="rounded-full border border-[#EADBD3] bg-white px-5 py-2 hover:border-[#9A6B5B]">← 前へ</Link> : null}
            <span className="text-[#5C4035]">{page} / {pageCount}ページ</span>
            {page < pageCount ? <Link href={href({ page: page + 1 })} className="rounded-full border border-[#EADBD3] bg-white px-5 py-2 hover:border-[#9A6B5B]">次へ →</Link> : null}
          </nav>
        ) : null}
      </div>
    </main>
  );
}

const PAGE_SIZE = 48;

function chip(active: boolean): string {
  return active
    ? "rounded-full bg-[#3B241A] px-4 py-1.5 text-sm text-white"
    : "rounded-full border border-[#EADBD3] bg-white px-4 py-1.5 text-sm text-[#5C4035] hover:border-[#9A6B5B]";
}
