import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductCard } from "@/components/product-card";
import { listPublishedShopListings } from "@/lib/shop/store";
import { STOREFRONT_CATEGORIES, categoryOf, pickDistinct } from "@/lib/shop/storefront-display";

export const dynamic = "force-dynamic";

const CATEGORY_COPY: Record<string, { title: string; description: string; intro: string; keywords: string[] }> = {
  bags: {
    title: "レディースバッグ通販｜ハンドバッグ・ショルダーバッグ",
    description: "毎日の通勤や休日のお出かけに合わせやすいレディースバッグをセレクト。ハンドバッグ、ショルダーバッグ、トートバッグを商品画像・価格とともに比較できます。",
    intro: "通勤にも休日にも合わせやすい形やデザインから、毎日使いたいバッグを探せます。",
    keywords: ["レディースバッグ", "ハンドバッグ", "ショルダーバッグ", "トートバッグ"],
  },
  hair: {
    title: "ヘアアクセサリー通販｜ヘアクリップ・バレッタ",
    description: "ヘアクリップ、バレッタ、シュシュなど毎日のヘアアレンジに使いやすいヘアアクセサリーをセレクト。商品画像と価格を見ながらお選びいただけます。",
    intro: "まとめ髪やいつものヘアアレンジに、小さなアクセントを添えるアイテムを集めました。",
    keywords: ["ヘアアクセサリー", "ヘアクリップ", "バレッタ", "シュシュ"],
  },
  makeup: {
    title: "メイク小物・メイクブラシ用品通販｜TRACER",
    description: "メイクブラシや収納、お手入れ用品など、毎日のメイクに役立つ小物をセレクト。商品情報・価格・在庫を確認してお選びいただけます。",
    intro: "メイク道具を使いやすく整え、日々のお手入れをサポートするアイテムを集めました。",
    keywords: ["メイク小物", "メイクブラシ", "メイクブラシクリーナー", "コスメ収納"],
  },
  other: {
    title: "暮らしのセレクト雑貨通販｜TRACER",
    description: "毎日の暮らしに取り入れやすいセレクト雑貨をご紹介。商品画像・価格・在庫などの商品情報を確認してお選びいただけます。",
    intro: "日々の暮らしを少し便利にする、気になるアイテムを探してみてください。",
    keywords: ["セレクト雑貨", "暮らしの雑貨", "日用品"],
  },
};

export async function generateStaticParams() {
  return STOREFRONT_CATEGORIES.map((category) => ({ slug: category.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const category = STOREFRONT_CATEGORIES.find((item) => item.slug === slug);
  const copy = CATEGORY_COPY[slug];
  if (!category || !copy) return { title: "カテゴリが見つかりません", robots: { index: false, follow: false } };
  return {
    title: copy.title,
    description: copy.description,
    keywords: copy.keywords,
    alternates: { canonical: `/shop/category/${slug}` },
    openGraph: {
      type: "website",
      locale: "ja_JP",
      siteName: "TRACER",
      title: copy.title,
      description: copy.description,
      url: `https://tracer-pied-alpha.vercel.app/shop/category/${slug}`,
    },
  };
}

export default async function ShopCategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const category = STOREFRONT_CATEGORIES.find((item) => item.slug === slug);
  const copy = CATEGORY_COPY[slug];
  if (!category || !copy) notFound();

  let listings: Awaited<ReturnType<typeof listPublishedShopListings>>;
  try {
    listings = await listPublishedShopListings();
  } catch {
    listings = [];
  }
  const items = pickDistinct(listings.filter((listing) => categoryOf(listing.title) === category.slug), 1800);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: copy.title,
    description: copy.description,
    url: `https://tracer-pied-alpha.vercel.app/shop/category/${slug}`,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.length,
      itemListElement: items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `https://tracer-pied-alpha.vercel.app/shop/${encodeURIComponent(item.slug)}`,
        name: item.title,
      })),
    },
  };

  return (
    <main className="min-h-[70vh] bg-[#FBF6F1] text-[#3B241A]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-5 py-8 sm:py-12">
        <nav aria-label="パンくず" className="mb-6 flex gap-2 text-xs text-[#9A6B5B]">
          <Link href="/">ホーム</Link><span aria-hidden="true">/</span><Link href="/shop">商品一覧</Link><span aria-hidden="true">/</span><span>{category.label}</span>
        </nav>
        <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">TRACER CATEGORY EDIT</p>
        <h1 className="mt-3 font-serif text-3xl leading-tight sm:text-4xl">{category.label}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-[#5C4035]">{copy.intro}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {copy.keywords.map((keyword) => <span key={keyword} className="rounded-full border border-[#EADBD3] bg-white/80 px-3 py-1.5 text-xs">{keyword}</span>)}
        </div>
        <div className="mt-8 flex items-end justify-between border-b border-[#EADBD3] pb-4">
          <p className="text-sm text-[#5C4035]">{items.length}点の商品</p>
          <Link href="/shop" className="text-sm underline underline-offset-4">すべての商品を見る →</Link>
        </div>
        {items.length ? (
          <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
            {items.map((listing, index) => <ProductCard key={listing.id} listing={listing} priority={index < 4} />)}
          </div>
        ) : (
          <p className="mt-8 rounded-2xl bg-white p-6 text-sm leading-7">現在、このカテゴリの商品を準備しています。<Link href="/shop" className="ml-1 underline">商品一覧へ</Link></p>
        )}
      </div>
    </main>
  );
}
