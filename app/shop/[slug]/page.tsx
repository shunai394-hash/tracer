import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { getShopifyConfig } from "@/lib/config/env";
import { getShopListingBySlug, listPublishedShopListings, recordShopFunnelEvent, type ShopListing } from "@/lib/shop/store";
import { ProductCard } from "@/components/product-card";
import { ProductImage } from "@/components/product-image";
import { STOREFRONT_CATEGORIES, categoryOf, pickDistinct, variantFamily } from "@/lib/shop/storefront-display";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const listing = await getShopListingBySlug(slug);
    if (!listing) return { title: "商品が見つかりません", robots: { index: false, follow: false } };

    const title = listing.title.trim();
    const description = (listing.description ?? `${title}の商品情報・価格・在庫をご確認いただけます。`)
      .replace(/\\s+/g, " ")
      .slice(0, 155);
    const url = `/shop/${encodeURIComponent(listing.slug)}`;
    return {
      title,
      description,
      alternates: { canonical: url },
      openGraph: {
        type: "website",
        locale: "ja_JP",
        siteName: "TRACER",
        title,
        description,
        url,
        ...(listing.imageUrl ? { images: [{ url: listing.imageUrl, alt: title }] } : {}),
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        ...(listing.imageUrl ? { images: [listing.imageUrl] } : {}),
      },
    };
  } catch {
    return { title: "商品情報", robots: { index: false, follow: true } };
  }
}


async function loadShopProduct(slug: string) {
  try {
    const listing = await getShopListingBySlug(slug);
    if (!listing) {
      return { listing: null, configError: false } as const;
    }

    const isLivenessCheck = (await headers()).get("x-tracer-liveness-check") === "1";
    if (!isLivenessCheck) {
      await recordShopFunnelEvent({ listingId: listing.id, eventType: "view" });
    }

    return { listing, configError: false } as const;
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return { listing: null, configError: true } as const;
    }
    throw error;
  }
}

export default async function ShopProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { listing, configError } = await loadShopProduct(slug);

  if (configError) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          商品情報を読み込めません。時間をおいてもう一度お試しください。
        </div>
      </main>
    );
  }

  if (!listing) notFound();

  const rawShopifyDomain = getShopifyConfig().storeDomain.trim();
  const shopifyDomain = rawShopifyDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shopifyProductUrl = listing.shopifySyncStatus === "synced" && listing.shopifyHandle && shopifyDomain
    ? `https://${shopifyDomain}/products/${encodeURIComponent(listing.shopifyHandle)}`
    : null;

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    description: listing.description ?? undefined,
    image: listing.imageUrl ? [listing.imageUrl] : undefined,
    offers: listing.sellingPrice && listing.currency ? {
      "@type": "Offer",
      price: listing.sellingPrice,
      priceCurrency: listing.currency,
      availability: listing.inventory > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: new URL(`/shop/${encodeURIComponent(listing.slug)}`, "https://tracer-pied-alpha.vercel.app").toString(),
    } : undefined,
  };

  let related: ShopListing[] = [];
  try {
    const family = variantFamily(listing.title);
    const category = categoryOf(listing.title);
    related = pickDistinct(
      (await listPublishedShopListings()).filter((item) => item.id !== listing.id && categoryOf(item.title) === category && variantFamily(item.title) !== family),
      4,
    );
  } catch {
    // Related items are optional; the product itself must still render.
  }
  const category = STOREFRONT_CATEGORIES.find((item) => item.slug === categoryOf(listing.title));

  return (
    <main className="min-h-screen w-full flex-1 bg-[#FBF6F1] text-[#3B241A]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }} />
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <nav aria-label="パンくず" className="mb-5 flex flex-wrap items-center gap-2 text-xs text-[#9A6B5B] sm:mb-8">
          <Link href="/" className="hover:underline">ホーム</Link>
          <span aria-hidden="true">/</span>
          <Link href="/shop" className="hover:underline">商品一覧</Link>
          {category ? (
            <>
              <span aria-hidden="true">/</span>
              <Link href={`/shop?cat=${category.slug}`} className="hover:underline">{category.label}</Link>
            </>
          ) : null}
        </nav>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-12">
          <div className="md:sticky md:top-24 md:self-start">
            <div className="overflow-hidden rounded-2xl bg-[#F4ECE6]">
              <ProductImage src={listing.imageUrl} alt={listing.title} eager className="aspect-[4/5] w-full object-cover" />
            </div>
          </div>

          <div>
            {category ? <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">{category.label}</p> : null}
            <h1 className="mt-2 font-serif text-2xl leading-snug sm:text-[28px]">{listing.title}</h1>

            <div className="mt-5 flex items-baseline gap-2">
              <p className="text-[28px] font-semibold tracking-tight">{formatMoney(listing.sellingPrice, listing.currency)}</p>
              <span className="text-xs text-neutral-500">税込・送料込み</span>
            </div>
            <p className={listing.inventory > 0 && listing.inventory <= 5 ? "mt-2 text-sm text-[#B84A62]" : "mt-2 text-sm text-[#5C4035]"}>
              {listing.inventory <= 0 ? "在庫切れ" : listing.inventory <= 5 ? `残りわずか（あと${listing.inventory}点）` : "在庫あり"}
            </p>

            <div className="mt-6">
              {shopifyProductUrl ? (
                <a
                  href={shopifyProductUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center rounded-full bg-[#3B241A] px-6 py-4 text-sm font-medium text-white transition hover:bg-[#5C4035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B] focus-visible:ring-offset-2"
                >
                  Shopifyで購入する
                </a>
              ) : (
                <AddToCartButton
                  listingId={listing.id}
                  slug={listing.slug}
                  title={listing.title}
                  unitPrice={listing.sellingPrice}
                  currency={listing.currency}
                  imageUrl={listing.imageUrl}
                />
              )}
              <p className="mt-3 text-center text-xs leading-5 text-neutral-500">
                ご購入手続きはTRACER公式ストア（Shopify）で安全に行われます。
              </p>
            </div>

            <ul className="mt-6 grid grid-cols-3 gap-2 text-center text-[11px] leading-4 text-[#5C4035] sm:text-xs">
              <li className="rounded-xl bg-white/70 px-2 py-3">送料込み<br />の価格表示</li>
              <li className="rounded-xl bg-white/70 px-2 py-3">追跡番号付き<br />で発送</li>
              <li className="rounded-xl bg-white/70 px-2 py-3">在庫確認済み<br />の商品のみ掲載</li>
            </ul>

            {listing.description ? (
              <section aria-labelledby="description-heading" className="mt-8 border-t border-[#EADBD3] pt-6">
                <h2 id="description-heading" className="font-serif text-lg">商品説明</h2>
                <p className="mt-3 whitespace-pre-line text-sm leading-7 text-[#5C4035]">{listing.description}</p>
              </section>
            ) : null}

            <div className="mt-6 divide-y divide-[#EADBD3] border-y border-[#EADBD3] text-sm">
              <details className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                  サイズ・素材・カラー
                  <span aria-hidden="true" className="text-[#9A6B5B] transition group-open:rotate-45">＋</span>
                </summary>
                <p className="mt-3 leading-7 text-[#5C4035]">
                  サイズ・素材・カラーなど、商品ごとの仕様を購入前にご確認ください。商品画像はモニター環境により実物と色味が異なって見える場合があります。
                </p>
              </details>
              <details className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                  配送・送料・返品について
                  <span aria-hidden="true" className="text-[#9A6B5B] transition group-open:rotate-45">＋</span>
                </summary>
                <p className="mt-3 leading-7 text-[#5C4035]">
                  在庫・配送日数・送料・返品条件は商品や配送先によって異なります。表示価格には日本国内への送料が含まれています。詳しくはご購入画面でご確認ください。
                </p>
              </details>
            </div>
          </div>
        </div>

        {related.length > 0 ? (
          <section aria-labelledby="related-heading" className="mt-16 sm:mt-24">
            <div className="flex items-end justify-between gap-4">
              <h2 id="related-heading" className="font-serif text-xl sm:text-2xl">あわせて見たい{category ? category.label : "アイテム"}</h2>
              {category ? <Link href={`/shop?cat=${category.slug}`} className="shrink-0 text-sm text-[#5C4035] underline-offset-4 hover:underline">もっと見る →</Link> : null}
            </div>
            <div className="mt-6 grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-4 sm:gap-x-5">
              {related.map((item) => <ProductCard key={item.id} listing={item} />)}
            </div>
          </section>
        ) : null}
        <div className="pb-10" />
      </div>
    </main>
  );
}
