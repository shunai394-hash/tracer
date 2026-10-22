import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { getShopifyConfig } from "@/lib/config/env";
import { getShopListingBySlug, recordShopFunnelEvent } from "@/lib/shop/store";
import { listEvidenceForProduct } from "@/lib/market/evidence-ledger";
import { formatMoney } from "@/lib/intelligence/format-display";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
    return { title: "商品情報｜TRACER", robots: { index: false, follow: true } };
  }
}


async function loadShopProduct(slug: string) {
  try {
    const listing = await getShopListingBySlug(slug);
    if (!listing) {
      return { listing: null, evidence: [], bestseller: null, configError: false } as const;
    }

    const isLivenessCheck = (await headers()).get("x-tracer-liveness-check") === "1";
    if (!isLivenessCheck) {
      await recordShopFunnelEvent({ listingId: listing.id, eventType: "view" });
    }

    const evidence = listing.productId ? await listEvidenceForProduct(listing.productId) : [];
    const supabase = createSupabaseAdminClient();
    const { data: bestseller } = listing.bestsellerId
      ? await supabase
          .from("marketplace_bestsellers")
          .select("marketplace, rank, source, product_url, fetched_at")
          .eq("id", listing.bestsellerId)
          .maybeSingle()
      : { data: null };

    return { listing, evidence, bestseller, configError: false } as const;
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return { listing: null, evidence: [], bestseller: null, configError: true } as const;
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
  const { listing, evidence, bestseller, configError } = await loadShopProduct(slug);

  if (configError) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <div role="alert" className="border border-amber-400/20 bg-amber-400/5 px-5 py-4 text-sm text-amber-200">
          商品情報を読み込めません。時間をおいてもう一度お試しください。
        </div>
      </main>
    );
  }

  if (!listing) notFound();

  const rawShopifyDomain = getShopifyConfig().storeDomain.trim();
  const shopifyDomain = rawShopifyDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shopifyVariantNumericId = listing.shopifyVariantId?.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)?.[1] ?? null;
  const shopifyProductUrl = listing.shopifySyncStatus === "synced" && listing.shopifyHandle && shopifyDomain
    ? `https://${shopifyDomain}/products/${encodeURIComponent(listing.shopifyHandle)}${shopifyVariantNumericId ? `?variant=${shopifyVariantNumericId}` : ""}`
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
      url: `/shop/${listing.slug}`,
    } : undefined,
  };

  return (
    <main className="min-h-screen w-full flex-1 bg-zinc-950 text-zinc-100">
      <div className="relative mx-auto w-full max-w-7xl px-5 py-8 sm:px-6 sm:py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] overflow-hidden" aria-hidden="true">
        <div className="absolute -left-40 top-12 h-80 w-80 rounded-full bg-cyan-400/[0.06] blur-3xl" />
        <div className="absolute right-0 top-0 h-72 w-72 rounded-full bg-amber-300/[0.04] blur-3xl" />
      </div>

      <nav aria-label="パンくず" className="relative mb-8 flex items-center gap-2 text-[11px] text-zinc-600">
        <Link href="/shop" className="transition hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
          商品一覧
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-zinc-400">商品詳細</span>
      </nav>

      <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.12fr)_minmax(360px,0.88fr)] lg:gap-12">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="relative overflow-hidden border border-white/10 bg-zinc-950/70 shadow-2xl shadow-black/30">
            <div className="absolute left-4 top-4 z-10 flex items-center gap-2 border border-white/10 bg-black/60 px-3 py-2 text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-300 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden="true" />
セレクト商品
            </div>
            {listing.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={listing.imageUrl}
                alt={listing.title}
                className="aspect-square w-full object-cover transition duration-700 motion-safe:hover:scale-[1.015]"
              />
            ) : (
              <div className="flex aspect-square items-center justify-center bg-zinc-900 text-sm text-zinc-600">
                商品画像を準備中です
              </div>
            )}
          </div>

        </div>

        <div className="relative lg:pt-2">
          <div className="flex flex-wrap gap-2 text-[10px] font-mono uppercase tracking-[0.2em]">
            <span className="border border-cyan-300/20 bg-cyan-300/5 px-2.5 py-1.5 text-cyan-200">セレクト商品</span>
            {bestseller ? (
              <span className="border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-zinc-400">市場で注目</span>
            ) : null}
          </div>

          <h1 className="mt-5 max-w-2xl text-[clamp(2rem,4vw,3.7rem)] font-medium leading-[1.08] tracking-[-0.035em] text-zinc-50">
            {listing.title}
          </h1>

          {listing.description ? (
            <p className="mt-6 max-w-xl text-sm leading-7 text-zinc-300 sm:text-base">{listing.description}</p>
          ) : null}


          {bestseller ? (
            <div className="mt-6 flex items-center justify-between border border-white/10 bg-white/[0.025] px-4 py-3">
              <div>
                <p className="text-xs text-zinc-500">市場での注目情報</p>
                <p className="mt-1 text-xs text-zinc-300">{bestseller.marketplace}で確認された候補</p>
              </div>
              <p className="text-lg font-medium text-cyan-200">#{bestseller.rank}</p>
            </div>
          ) : null}

          <div className="mt-8 border border-white/10 bg-zinc-950/75 p-5 sm:p-6">
            <div className="flex items-end justify-between gap-5">
              <div>
                <p className="text-sm text-zinc-400">価格</p>
                <p className="mt-1 text-3xl font-medium tracking-[-0.03em] text-zinc-50">
                  {formatMoney(listing.sellingPrice, listing.currency)}
                </p>
              </div>
              <span className="pb-1 text-[10px] text-zinc-600">税込表示価格</span>
            </div>

            <div className="mt-5">
              {shopifyProductUrl ? (
                <a
                  href={shopifyProductUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center rounded-sm bg-cyan-300 px-5 py-4 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100"
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
            </div>
            <p className="mt-3 text-center text-[11px] leading-5 text-zinc-600">
              在庫と購入手続きは販売先の最新情報をご確認ください。
            </p>
          </div>

          <div className="mt-6 border-l border-cyan-300/30 pl-4">
            <p className="text-xs font-medium text-zinc-200">掲載理由を、隠さない。</p>
            <p className="mt-2 text-xs leading-6 text-zinc-500">
              サイズ・素材・カラー・仕様は、購入前に商品画像と販売先の最新情報をご確認ください。
            </p>
          </div>
        </div>
      </div>

      <section aria-labelledby="why-heading" className="relative mt-20 border-t border-white/10 pt-10 sm:mt-24">
        <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16">
          <div>
            <p className="text-xs tracking-wide text-cyan-300/70">この商品について</p>
            <h2 id="why-heading" className="mt-3 max-w-sm text-2xl font-medium tracking-tight text-zinc-100 sm:text-3xl">
              商品情報を確認してから購入する。
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-zinc-500">
              サイズ・素材・カラーなど、商品ごとの仕様を購入前にご確認ください。
            </p>
          </div>

          <div className="grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-2">
            <div className="bg-zinc-950/70 p-6 sm:p-7">
              <p className="text-xs text-zinc-500">掲載情報</p>
              <p className="mt-4 text-base font-medium text-zinc-200">TRACERの商品データ</p>
              <p className="mt-2 text-sm leading-7 text-zinc-500">
                商品名・画像・価格は登録された掲載情報を表示しています。詳細は販売先の商品ページでもご確認ください。
              </p>
            </div>
            <div className="bg-zinc-950/70 p-6 sm:p-7">
              <p className="text-xs text-zinc-500">購入前の確認</p>
              <p className="mt-4 text-base font-medium text-zinc-200">販売先の最新情報</p>
              <p className="mt-2 text-sm leading-7 text-zinc-500">
                在庫・配送日数・送料・返品条件は商品や配送先によって異なります。購入手続きの前に販売先でご確認ください。
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
    </main>
  );
}
