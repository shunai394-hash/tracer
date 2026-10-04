import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { getShopListingBySlug, recordShopFunnelEvent } from "@/lib/shop/store";
import { listEvidenceForProduct } from "@/lib/market/evidence-ledger";
import { formatMoney } from "@/lib/intelligence/format-display";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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

  const hasEvidence = evidence.length > 0;
  const marketplaceLabel = bestseller?.marketplace ?? "TRACER";

  return (
    <main className="relative mx-auto w-full max-w-7xl flex-1 px-5 py-8 sm:px-6 sm:py-12">
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
              TRACER SELECTED
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

          <div className="mt-3 flex items-center justify-between px-1 text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-700">
            <span>Verified selection</span>
            <span>{evidence.length > 0 ? `${evidence.length} evidence` : "Evidence on file"}</span>
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

          <div className="mt-8 grid grid-cols-3 border-y border-white/10 py-5">
            <div className="border-r border-white/10 pr-3">
              <p className="text-[9px] font-mono uppercase tracking-[0.15em] text-zinc-600">Signal</p>
              <p className="mt-1 text-sm text-zinc-200">{bestseller ? "Detected" : "Checked"}</p>
            </div>
            <div className="border-r border-white/10 px-3">
              <p className="text-[9px] font-mono uppercase tracking-[0.15em] text-zinc-600">Source</p>
              <p className="mt-1 truncate text-sm text-zinc-200">{marketplaceLabel}</p>
            </div>
            <div className="pl-3">
              <p className="text-[9px] font-mono uppercase tracking-[0.15em] text-zinc-600">Evidence</p>
              <p className="mt-1 text-sm text-zinc-200">{hasEvidence ? `${evidence.length}件` : "確認済み"}</p>
            </div>
          </div>

          {bestseller ? (
            <div className="mt-6 flex items-center justify-between border border-white/10 bg-white/[0.025] px-4 py-3">
              <div>
                <p className="text-[9px] font-mono uppercase tracking-[0.16em] text-zinc-600">Market signal</p>
                <p className="mt-1 text-xs text-zinc-300">{bestseller.marketplace}で確認された候補</p>
              </div>
              <p className="text-lg font-medium text-cyan-200">#{bestseller.rank}</p>
            </div>
          ) : null}

          <div className="mt-8 border border-white/10 bg-zinc-950/75 p-5 sm:p-6">
            <div className="flex items-end justify-between gap-5">
              <div>
                <p className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-600">Price</p>
                <p className="mt-1 text-3xl font-medium tracking-[-0.03em] text-zinc-50">
                  {formatMoney(listing.sellingPrice, listing.currency)}
                </p>
              </div>
              <span className="pb-1 text-[10px] text-zinc-600">税込表示価格</span>
            </div>

            <div className="mt-5">
              <AddToCartButton
                listingId={listing.id}
                slug={listing.slug}
                title={listing.title}
                unitPrice={listing.sellingPrice}
                currency={listing.currency}
                imageUrl={listing.imageUrl}
              />
            </div>
            <p className="mt-3 text-center text-[11px] leading-5 text-zinc-600">
              購入手続きへ進む前に、カート内容と配送先をご確認ください。
            </p>
          </div>

          <div className="mt-6 border-l border-cyan-300/30 pl-4">
            <p className="text-xs font-medium text-zinc-200">掲載理由を、隠さない。</p>
            <p className="mt-2 text-xs leading-6 text-zinc-500">
              市場の動き、商品情報、仕入条件、価格条件を確認したうえで掲載しています。確認できない情報を推測で補っていません。
            </p>
          </div>
        </div>
      </div>

      <section aria-labelledby="why-heading" className="relative mt-20 border-t border-white/10 pt-10 sm:mt-24">
        <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-300/70">Why this item</p>
            <h2 id="why-heading" className="mt-3 max-w-sm text-2xl font-medium tracking-tight text-zinc-100 sm:text-3xl">
              「気になる」で終わらせない。
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-zinc-500">
              TRACERは、商品を並べるだけではなく、なぜ候補になったのかを追える状態にします。
            </p>
          </div>

          <div className="grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-2">
            <div className="bg-zinc-950/70 p-6 sm:p-7">
              <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">01 / Market</p>
              <p className="mt-4 text-base font-medium text-zinc-200">市場シグナル</p>
              <p className="mt-2 text-sm leading-7 text-zinc-500">
                {bestseller ? "市場で確認できた動きを起点に、商品候補として扱っています。" : "商品情報と選定条件を確認したうえで掲載しています。"}
              </p>
            </div>
            <div className="bg-zinc-950/70 p-6 sm:p-7">
              <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">02 / Evidence</p>
              <p className="mt-4 text-base font-medium text-zinc-200">確認できた情報</p>
              <p className="mt-2 text-sm leading-7 text-zinc-500">
                {hasEvidence ? "商品について確認できた情報をもとに、ページの根拠を構成しています。" : "確認できた情報だけを使って商品ページを構成しています。"}
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
