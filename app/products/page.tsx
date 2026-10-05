import Link from "next/link";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatConfidence, formatMoney, formatUnits } from "@/lib/intelligence/format-display";
import { listReorderRecommendations } from "@/lib/ordering/store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ShopLink = {
  id: string;
  product_id: string | null;
  slug: string;
  title: string;
  published: boolean | null;
  pipeline_stage: string | null;
  pipeline_status: string | null;
  supplier_name: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | string | null;
  orderable: boolean | null;
  tracking_available: boolean | null;
  selling_price: number | string | null;
  currency: string | null;
};

export default async function ProductsPage() {
  let products: Array<{
    product_id: string;
    normalized_title: string;
    brand_name: string | null;
    current_price: number | string | null;
    currency: string | null;
  }> = [];
  let reorders: Awaited<ReturnType<typeof listReorderRecommendations>> = [];
  let shopLinks: ShopLink[] = [];
  let error: string | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const [productResult, listingResult] = await Promise.all([
      supabase
        .from("product_intelligence")
        .select("product_id, normalized_title, brand_name, current_price, currency")
        .order("updated_at", { ascending: false })
        .limit(50),
      supabase
        .from("shop_listings")
        .select("id,product_id,slug,title,published,pipeline_stage,pipeline_status,supplier_name,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,selling_price,currency")
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);

    if (productResult.error) throw new Error(productResult.error.message);
    if (listingResult.error) throw new Error(listingResult.error.message);

    products = productResult.data ?? [];
    shopLinks = (listingResult.data ?? []) as ShopLink[];

    try {
      reorders = await listReorderRecommendations(100);
    } catch {
      reorders = [];
    }
  } catch (caught) {
    if (!(caught instanceof SupabaseConfigError)) {
      error = caught instanceof Error ? caught.message : "商品を読み込めませんでした。";
    }
  }

  const listingByProduct = new Map<string, ShopLink[]>();
  for (const listing of shopLinks) {
    if (!listing.product_id) continue;
    const rows = listingByProduct.get(listing.product_id) ?? [];
    rows.push(listing);
    listingByProduct.set(listing.product_id, rows);
  }

  const publishedCount = shopLinks.filter((listing) => listing.published === true).length;
  const linkedCount = shopLinks.filter(
    (listing) => listing.supplier_product_id && listing.supplier_variant_id,
  ).length;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">Products / Operations</p>
          <h1 className="mt-3 text-3xl text-zinc-50">商品管理</h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-zinc-400">
            Product実体と販売掲載を同じ画面で追跡します。掲載商品はsupplier product / variant / 在庫 / 注文可否まで確認できる状態を管理対象とします。
          </p>
        </div>
        <Link href="/dashboard" className="border border-white/10 px-4 py-2 text-xs text-zinc-300 transition hover:border-cyan-300/30 hover:text-cyan-100">
          運用ダッシュボード ↗
        </Link>
      </div>

      <section className="mt-10 grid gap-px border border-white/8 bg-white/8 sm:grid-cols-3">
        <div className="bg-[#080b0e] p-5"><p className="font-mono text-[8px] tracking-[.2em] text-zinc-600">PRODUCTS</p><p className="mt-2 text-2xl text-zinc-100">{products.length}</p></div>
        <div className="bg-[#080b0e] p-5"><p className="font-mono text-[8px] tracking-[.2em] text-zinc-600">PUBLISHED LISTINGS</p><p className="mt-2 text-2xl text-cyan-200">{publishedCount}</p></div>
        <div className="bg-[#080b0e] p-5"><p className="font-mono text-[8px] tracking-[.2em] text-zinc-600">SUPPLIER + VARIANT LINKED</p><p className="mt-2 text-2xl text-zinc-100">{linkedCount}</p></div>
      </section>

      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}

      {products.length === 0 ? (
        <div className="mt-10 border border-dashed border-cyan-500/20 p-10 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">Empty catalog</p>
          <p className="mt-3 text-sm text-zinc-400">登録済みの商品はまだありません。</p>
        </div>
      ) : (
        <div className="mt-10 space-y-3">
          {products.map((product) => {
            const reorder = reorders.find((item) => item.productId === product.product_id);
            const listings = listingByProduct.get(product.product_id) ?? [];
            return (
              <article key={product.product_id} className="border border-white/8 bg-[#080b0e] p-5 sm:p-6">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{product.normalized_title}</p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-600">
                      {product.brand_name ?? "no brand"}
                      {product.current_price !== null && product.currency ? ` / ${product.currency} ${product.current_price}` : " / price unknown"}
                    </p>
                  </div>
                  <span className="font-mono text-[9px] tracking-[.15em] text-zinc-700">{product.product_id}</span>
                </div>

                {reorder ? (
                  <p className="mt-4 text-xs text-zinc-400">
                    現在庫 {reorder.onHand ?? "unknown"} · 30日予測 {formatUnits(reorder.forecastUnits30d)} · ROP {reorder.reorderPoint ?? "unknown"} · 推奨 {reorder.recommendedQty ?? "unknown"} · {formatMoney(reorder.estimatedCost, reorder.currency)} · {formatConfidence(reorder.confidence)} · {reorder.orderState}
                  </p>
                ) : (
                  <p className="mt-4 text-xs text-zinc-600">自社在庫未記録のため発注指標は unknown</p>
                )}

                <div className="mt-5 border-t border-white/6 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-mono text-[9px] tracking-[.2em] text-zinc-600">SHOP / SUPPLIER LINKAGE</p>
                    <span className="text-[9px] text-zinc-700">{listings.length} listing{listings.length === 1 ? "" : "s"}</span>
                  </div>
                  {listings.length === 0 ? (
                    <p className="mt-3 border border-dashed border-white/8 px-4 py-4 text-xs text-zinc-600">
                      掲載なし。Sales Test Gate / 供給確認の完了待ち。
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {listings.map((listing) => {
                        const supplierLinked = Boolean(listing.supplier_name && listing.supplier_product_id && listing.supplier_variant_id);
                        const operational = listing.orderable === true && Number(listing.inventory ?? 0) > 0 && listing.tracking_available === true;
                        return (
                          <div key={listing.id} className="border border-white/6 bg-black/20 p-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={listing.published ? "text-cyan-200" : "text-zinc-500"}>{listing.published ? "● PUBLISHED" : "○ NOT PUBLISHED"}</span>
                                  <span className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{listing.pipeline_stage ?? "—"} / {listing.pipeline_status ?? "—"}</span>
                                </div>
                                <p className="mt-2 text-sm text-zinc-200">{listing.title}</p>
                              </div>
                              <Link href={`/shop/${listing.slug}`} className="shrink-0 text-[9px] font-mono tracking-[.15em] text-zinc-500 hover:text-cyan-200">STORE ↗</Link>
                            </div>
                            <div className="mt-4 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-5">
                              <div><span className="text-zinc-700">SUPPLIER</span><p className={supplierLinked ? "text-cyan-200" : "text-zinc-500"}>{listing.supplier_name ?? "—"}</p></div>
                              <div><span className="text-zinc-700">PRODUCT</span><p className="break-all font-mono text-zinc-400">{listing.supplier_product_id ?? "—"}</p></div>
                              <div><span className="text-zinc-700">VARIANT</span><p className="break-all font-mono text-zinc-400">{listing.supplier_variant_id ?? "—"}</p></div>
                              <div><span className="text-zinc-700">INVENTORY</span><p className={operational ? "text-cyan-200" : "text-zinc-500"}>{listing.inventory ?? "unknown"}</p></div>
                              <div><span className="text-zinc-700">ORDERABLE</span><p className={operational ? "text-cyan-200" : "text-amber-300"}>{listing.orderable === true ? "YES" : "NO"}{listing.tracking_available === true ? " · TRACK" : ""}</p></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
