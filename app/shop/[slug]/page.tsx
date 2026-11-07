import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ProductVariantSelector } from "@/components/product-variant-selector";
import { getShopifyConfig } from "@/lib/config/env";
import { getShopListingBySlug, listPublishedShopListings, recordShopFunnelEvent, type ShopListing } from "@/lib/shop/store";
import { ProductCard } from "@/components/product-card";
import { STOREFRONT_CATEGORIES, categoryOf, pickOnePerSupplierProduct, variantFamily } from "@/lib/shop/storefront-display";
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
      .replace(/\s+/g, " ")
      .slice(0, 155);
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "");
    const url = new URL(`/shop/${encodeURIComponent(listing.slug)}`, siteUrl).toString();
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
  const shopifyDomain = (rawShopifyDomain || "ieufrg-tb.myshopify.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const isDomesticFreeShippingItem = listing.id === "1ae04dd1-a228-43b7-b003-3a2fb75da98a";
  const storefrontBaseUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "");
  const productUrl = new URL(`/shop/${encodeURIComponent(listing.slug)}`, storefrontBaseUrl).toString();
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    description: listing.description ?? undefined,
    image: listing.imageUrl ? [listing.imageUrl] : undefined,
    mainEntityOfPage: productUrl,
    url: productUrl,
    offers: listing.sellingPrice && listing.currency ? {
      "@type": "Offer",
      price: listing.sellingPrice,
      priceCurrency: listing.currency,
      availability: listing.inventory > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: productUrl,
      ...(isDomesticFreeShippingItem ? { shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: "0", currency: "JPY" }, shippingDestination: { "@type": "DefinedRegion", addressCountry: "JP" } } } : {}),
    } : undefined,
  };

  let related: ShopListing[] = [];
  try {
    const family = variantFamily(listing.title);
    const category = categoryOf(listing.title);
    related = pickOnePerSupplierProduct(
      (await listPublishedShopListings()).filter((item) => item.id !== listing.id && categoryOf(item.title) === category && variantFamily(item.title) !== family),
      4,
    );
  } catch {
    // Related items are optional; the product itself must still render.
  }
  const category = STOREFRONT_CATEGORIES.find((item) => item.slug === categoryOf(listing.title));
  const breadcrumbItems = [
    { name: "ホーム", item: `${storefrontBaseUrl}/` },
    { name: "商品一覧", item: `${storefrontBaseUrl}/shop` },
    ...(category ? [{ name: category.label, item: `${storefrontBaseUrl}/shop/category/${category.slug}` }] : []),
    { name: listing.title, item: productUrl },
  ];
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbItems.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.item,
    })),
  };

  return (
    <main className="min-h-screen w-full flex-1 bg-[#FBF6F1] text-[#3B241A]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd).replace(/</g, "\\u003c") }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, "\\u003c") }} />
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <nav aria-label="パンくず" className="mb-5 flex flex-wrap items-center gap-2 text-xs text-[#9A6B5B] sm:mb-8">
          <Link href="/" className="hover:underline">ホーム</Link>
          <span aria-hidden="true">/</span>
          <Link href="/shop" className="hover:underline">商品一覧</Link>
          {category ? (
            <>
              <span aria-hidden="true">/</span>
              <Link href={`/shop/category/${category.slug}`} className="hover:underline">{category.label}</Link>
            </>
          ) : null}
        </nav>

        <ProductVariantSelector
          listing={listing}
          variants={listing.variants ?? []}
          categoryLabel={category?.label ?? null}
          shopifyDomain={shopifyDomain}
        />
        {isDomesticFreeShippingItem ? <p className="mt-3 inline-flex items-center rounded-full border border-[#D7B9A8] bg-white px-4 py-2 text-sm font-semibold text-[#75402F]">国内送料無料</p> : null}
        {listing.description ? (
          <section aria-labelledby="description-heading" className="mt-10 border-t border-[#EADBD3] pt-6">
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
              色を選択すると、対応する商品画像・価格・在庫が表示されます。色別画像を確認できない商品は購入できません。
              サイズ・素材・カラーなど、商品ごとの仕様を購入前にご確認ください。
            </p>
          </details>
          <details className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
              配送・送料・返品について
              <span aria-hidden="true" className="text-[#9A6B5B] transition group-open:rotate-45">＋</span>
            </summary>
            <p className="mt-3 leading-7 text-[#5C4035]">
              在庫・配送日数・送料・返品条件は商品や配送先によって異なります。送料・配送条件は購入手続き画面でご確認ください。
            </p>
          </details>
        </div>

        {related.length > 0 ? (
          <section aria-labelledby="related-heading" className="mt-16 sm:mt-24">
            <div className="flex items-end justify-between gap-4">
              <h2 id="related-heading" className="font-serif text-xl sm:text-2xl">あわせて見たい{category ? category.label : "アイテム"}</h2>
              {category ? <Link href={`/shop/category/${category.slug}`} className="shrink-0 text-sm text-[#5C4035] underline-offset-4 hover:underline">もっと見る →</Link> : null}
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
