import { notFound } from "next/navigation";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { getShopListingBySlug, recordShopFunnelEvent } from "@/lib/shop/store";
import { listEvidenceForProduct } from "@/lib/market/evidence-ledger";
import { formatMoney } from "@/lib/intelligence/format-display";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ShopProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  try {
    const listing = await getShopListingBySlug(slug);
    if (!listing) notFound();

    await recordShopFunnelEvent({
      listingId: listing.id,
      eventType: "view",
    });

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

    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
        <div className="grid gap-10 lg:grid-cols-2">
          {listing.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listing.imageUrl}
              alt={listing.title}
              className="w-full object-cover"
            />
          ) : (
            <div className="flex h-80 items-center justify-center border border-dashed border-white/10 text-zinc-600">
              画像 unknown
            </div>
          )}
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
              販売テスト商品
            </p>
            <h1 className="mt-3 text-3xl text-zinc-50">{listing.title}</h1>
            <p className="mt-4 text-2xl text-zinc-100">
              {formatMoney(listing.sellingPrice, listing.currency)}
            </p>
            <p className="mt-4 text-sm leading-6 text-zinc-400">
              {listing.description}
            </p>
            {bestseller ? (
              <p className="mt-4 text-sm text-zinc-400">
                市場根拠: {String(bestseller.marketplace)} ランキング{" "}
                {bestseller.rank ?? "unknown"} / {String(bestseller.source)} /{" "}
                {String(bestseller.fetched_at).slice(0, 10)}
              </p>
            ) : null}
            <div className="mt-8">
              <AddToCartButton
                listingId={listing.id}
                slug={listing.slug}
                title={listing.title}
                unitPrice={listing.sellingPrice}
                currency={listing.currency}
                imageUrl={listing.imageUrl}
              />
            </div>
          </div>
        </div>
        <section className="mt-12">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
            Evidence
          </h2>
          <ul className="mt-4 space-y-2 text-sm text-zinc-400">
            {evidence.slice(0, 12).map((row) => (
              <li key={String(row.id)}>
                {String(row.field_name)} = {row.field_value ?? "UNKNOWN"} /{" "}
                {String(row.evidence_class)} / {String(row.source)}
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-16">
          <p className="text-sm text-amber-300">店舗データを読めません。</p>
        </main>
      );
    }
    throw error;
  }
}
