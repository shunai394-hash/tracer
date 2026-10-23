import Link from "next/link";
import { listPublishedShopListings } from "@/lib/shop/store";
import { SupabaseConfigError } from "@/lib/supabase/server";
import { ProductCard } from "@/components/product-card";
import { STOREFRONT_CATEGORIES, categoryOf, variantFamily } from "@/lib/shop/storefront-display";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "商品一覧 — TRACER",
  description: "バッグ、ヘアアクセサリー、メイク小物など、価格と在庫を確認した商品一覧。",
};

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
  const showAll = param(query.all) === "1";

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

  // Default view collapses exact title families such as the same bag in different
  // colours. The full list remains available, and no database/order identity is changed.
  const matchingCount = shown.length;
  const familyCounts = new Map<string, number>();
  for (const listing of shown) {
    const family = variantFamily(listing.title);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }
  const duplicateCandidateCount = [...familyCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  if (!showAll) {
    const seenFamilies = new Set<string>();
    shown = shown.filter((listing) => {
      const family = variantFamily(listing.title);
      if (seenFamilies.has(family)) return false;
      seenFamilies.add(family);
      return true;
    });
  }

  const href = (next: { cat?: string; sort?: string }) => {
    const params = new URLSearchParams();
    const nextCat = next.cat ?? cat;
    const nextSort = next.sort ?? sort;
    if (nextCat) params.set("cat", nextCat);
    if (q) params.set("q", q);
    if (nextSort) params.set("sort", nextSort);
    if (showAll) params.set("all", "1");
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
            {!error && duplicateCandidateCount > 0 ? (
              <p className="mt-1 text-xs text-[#9A6B5B]">
                {showAll ? `色違いなどの重複候補を含む全${matchingCount}件` : `色違いなど同じ商品名の候補をまとめています（${duplicateCandidateCount}件を非表示）`}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {duplicateCandidateCount > 0 ? (
              <Link href={showAll ? href({}) : `/shop?${new URLSearchParams({ ...(cat ? { cat } : {}), ...(q ? { q } : {}), ...(sort ? { sort } : {}), all: "1" }).toString()}`} className="rounded-full border border-[#9A6B5B]/40 bg-white px-4 py-2 text-xs font-medium text-[#5C4035] hover:bg-[#F6E2E0]/60">
                {showAll ? "重複候補をまとめる" : "色違い・重複候補も表示"}
              </Link>
            ) : null}
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
            {shown.map((listing, index) => <ProductCard key={listing.id} listing={listing} priority={index < 4} />)}
          </div>
        )}
      </div>
    </main>
  );
}

function chip(active: boolean): string {
  return active
    ? "rounded-full bg-[#3B241A] px-4 py-1.5 text-sm text-white"
    : "rounded-full border border-[#EADBD3] bg-white px-4 py-1.5 text-sm text-[#5C4035] hover:border-[#9A6B5B]";
}
