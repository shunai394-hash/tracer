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

    const isLivenessCheck =
      (await headers()).get("x-tracer-liveness-check") === "1";
    if (!isLivenessCheck) {
      await recordShopFunnelEvent({ listingId: listing.id, eventType: "view" });
    }

    const evidence = listing.productId
      ? await listEvidenceForProduct(listing.productId)
      : [];
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

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
      <nav aria-label="パンくず" className="mb-7 text-xs text-zinc-500">
        <a href="/shop" className="transition hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
          商品一覧
        </a>
        <span className="mx-2" aria-hidden="true">/</span>
        <span className="text-zinc-400">商品詳細</span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
        <div className="overflow-hidden border border-white/10 bg-zinc-950/60">
          {listing.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listing.imageUrl}
              alt={listing.title}
              className="aspect-square w-full object-cover"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center text-sm text-zinc-600">
              商品画像を準備中です
            </div>
          )}
        </div>

        <div className="lg:pt-3">
          <div className="flex flex-wrap gap-2 text-[10px] font-mono uppercase tracking-[0.2em]">
            <span className="border border-cyan-300/20 bg-cyan-300/5 px-2.5 py-1.5 text-cyan-200">
              セレクト商品
            </span>
            {bestseller ? (
              <span className="border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-zinc-400">
                市場で注目
              </span>
            ) : null}
          </div>

          <h1 className="mt-5 text-3xl font-medium tracking-tight text-zinc-50 sm:text-4xl">
            {listing.title}
          </h1>

          {listing.description ? (
            <p className="mt-5 text-sm leading-7 text-zinc-300 sm:text-base">
              {listing.description}
            </p>
          ) : null}

          <div className="mt-8 border-y border-white/10 py-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">価格</p>
            <p className="mt-1 text-3xl font-medium tracking-tight text-zinc-50">
              {formatMoney(listing.sellingPrice, listing.currency)}
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              表示価格でカートに追加できます。
            </p>
          </div>

          <div className="mt-7 rounded-none border border-cyan-300/15 bg-cyan-300/[0.03] p-4">
            <p className="text-sm font-medium text-zinc-100">商品選定について</p>
            <p className="mt-2 text-xs leading-6 text-zinc-500">
              市場の動き、商品情報、仕入条件、価格条件を確認したうえで掲載しています。確認できない情報を推測で補っていません。
            </p>
          </div>

          <div className="mt-7">
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
      </div>

      <section aria-labelledby="why-heading" className="mt-14 border-t border-white/10 pt-10">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-300/70">Why this item</p>
        <h2 id="why-heading" className="mt-2 text-xl text-zinc-100">なぜ掲載されている？</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="border border-white/10 bg-zinc-950/40 p-5">
            <p className="text-sm font-medium text-zinc-200">市場シグナル</p>
            <p className="mt-2 text-xs leading-6 text-zinc-500">
              {bestseller
                ? "市場で確認できた動きをもとに選定しています。"
                : "商品情報と選定条件を確認したうえで掲載しています。"}
            </p>
          </div>
          <div className="border border-white/10 bg-zinc-950/40 p-5">
            <p className="text-sm font-medium text-zinc-200">確認済みの情報</p>
            <p className="mt-2 text-xs leading-6 text-zinc-500">
              {hasEvidence
                ? "商品について確認できた情報をもとに掲載しています。"
                : "確認できた情報だけを使って商品ページを構成しています。"}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
