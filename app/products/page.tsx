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

type GatePulse = {
  verifiedSupply: number;
  identityLinked: number;
  opportunityReady: number;
  published: number;
};

type CommerceProduct = { id: string; title_ja: string; description_ja: string | null; image_url: string | null; active: boolean; updated_at: string };
type CommerceVariant = { id: string; product_id: string; title_ja: string; sku: string | null; source_variant_key: string };
type CommerceOffer = { id: string; variant_id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; inventory: number | string; unit_cost: number | string; shipping_cost: number | string; raw_data: Record<string, unknown> | null; currency: string; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null };
type CommercePrice = { variant_id: string; supplier_offer_id: string; selling_price: number | string; expected_profit: number | string; margin_rate: number | string; currency: string };
type CommerceListing = { id: string; variant_id: string; channel: "base" | "shopify"; external_product_id: string | null; external_variant_id: string | null; external_sku: string | null; selling_price: number | string; status: string; published_url: string | null; last_error: string | null; last_synced_at: string | null };

function freshOfferByIdForDisplay(offers: CommerceOffer[], offerId: string, variantId: string): CommerceOffer | null {
  return offers.find((offer) => offer.id === offerId && offer.variant_id === variantId) ?? null;
}

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
  let commerceProducts: CommerceProduct[] = [];
  let commerceVariants: CommerceVariant[] = [];
  let commerceOffers: CommerceOffer[] = [];
  let commercePrices: CommercePrice[] = [];
  let commerceListings: CommerceListing[] = [];
  let gate: GatePulse = { verifiedSupply: 0, identityLinked: 0, opportunityReady: 0, published: 0 };
  let error: string | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const [productResult, listingResult, supplyCount, identityCount, readyCount, commerceProductResult, commerceVariantResult, commerceOfferResult, commercePriceResult, commerceListingResult] = await Promise.all([
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
      supabase
        .from("supplier_listings")
        .select("id", { count: "exact", head: true })
        .eq("orderable", true)
        .eq("inventory_confirmed", true)
        .gt("inventory", 0),
      supabase
        .from("supplier_listings")
        .select("id", { count: "exact", head: true })
        .eq("identity_status", "linked")
        .gte("identity_confidence", 0.88),
      supabase
        .from("opportunity_intelligence")
        .select("product_id", { count: "exact", head: true })
        .eq("sellability_state", "TEST_READY")
        .eq("selection_eligible", true)
        .eq("filter_state", "PASS")
        .eq("profit_state", "PROFIT_OK"),
      supabase.from("commerce_products").select("id,title_ja,description_ja,image_url,active,updated_at").order("updated_at", { ascending: false }).limit(500),
      supabase.from("commerce_variants").select("id,product_id,title_ja,sku,source_variant_key").order("updated_at", { ascending: false }).limit(500),
      supabase.from("supplier_offers").select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,unit_cost,shipping_cost,raw_data,currency,ship_to,tracking_supported,source_status,last_checked_at").limit(500),
      supabase.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,currency").limit(500),
      supabase.from("channel_listings").select("id,variant_id,channel,external_product_id,external_variant_id,external_sku,selling_price,status,published_url,last_error,last_synced_at").order("last_synced_at", { ascending: false }).limit(1000),
    ]);

    if (productResult.error) throw new Error(productResult.error.message);
    if (listingResult.error) throw new Error(listingResult.error.message);
    if (supplyCount.error) throw new Error(supplyCount.error.message);
    if (identityCount.error) throw new Error(identityCount.error.message);
    if (readyCount.error) throw new Error(readyCount.error.message);
    if (commerceProductResult.error) throw new Error(commerceProductResult.error.message);
    if (commerceVariantResult.error) throw new Error(commerceVariantResult.error.message);
    if (commerceOfferResult.error) throw new Error(commerceOfferResult.error.message);
    if (commercePriceResult.error) throw new Error(commercePriceResult.error.message);
    if (commerceListingResult.error) throw new Error(commerceListingResult.error.message);

    products = productResult.data ?? [];
    shopLinks = (listingResult.data ?? []) as ShopLink[];
    commerceProducts = (commerceProductResult.data ?? []) as CommerceProduct[];
    commerceVariants = (commerceVariantResult.data ?? []) as CommerceVariant[];
    commerceOffers = (commerceOfferResult.data ?? []) as CommerceOffer[];
    commercePrices = (commercePriceResult.data ?? []) as CommercePrice[];
    commerceListings = (commerceListingResult.data ?? []) as CommerceListing[];
    const freshnessCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const freshOffers = commerceOffers.filter((offer) =>
      offer.source_status === "verified" &&
      offer.ship_to === "JP" &&
      Boolean(offer.supplier_product_id && offer.supplier_variant_id) &&
      Number.isFinite(Number(offer.unit_cost)) && Number(offer.unit_cost) > 0 &&
      (Number(offer.shipping_cost) > 0 || (Number(offer.shipping_cost) === 0 && offer.raw_data?.shippingKnown === true)) &&
      Number.isFinite(Date.parse(String(offer.last_checked_at ?? ""))) &&
      Date.parse(String(offer.last_checked_at ?? "")) >= freshnessCutoff
    );
    const freshOfferById = new Map(freshOffers.map((offer) => [offer.id, offer]));
    const profitablePrices = commercePrices.filter((price) =>
      Number(price.selling_price) > 0 &&
      Number(price.expected_profit) > 0 &&
      freshOfferById.get(price.supplier_offer_id)?.variant_id === price.variant_id
    );
    gate = {
      verifiedSupply: freshOffers.length,
      identityLinked: freshOffers.filter((offer) => Boolean(offer.supplier_product_id && offer.supplier_variant_id)).length,
      opportunityReady: profitablePrices.length,
      published: commerceListings.filter((listing) => listing.status === "published").length,
    };

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

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14 sm:py-16">
      <header className="flex flex-col gap-7 border-b border-white/8 pb-9 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <p className="font-mono text-[9px] uppercase tracking-[0.38em] text-cyan-300/80">Products / Publication Control</p>
          <h1 className="mt-3 text-4xl font-medium tracking-[-0.04em] text-zinc-50 sm:text-5xl">商品管理</h1>
          <p className="mt-5 text-sm leading-7 text-zinc-400">
            商品・供給・掲載を一つの運用面に統合。公開状態だけでなく、Sales Test Gate がどこで止まっているかまで追跡します。
          </p>
        </div>
        <Link href="/dashboard" className="inline-flex w-fit border border-white/10 px-4 py-2.5 font-mono text-[9px] tracking-[.18em] text-zinc-300 transition hover:border-cyan-300/30 hover:text-cyan-100">
          OPERATIONS DASHBOARD ↗
        </Link>
      </header>

      <section className="mt-8 grid gap-px border border-white/8 bg-white/8 md:grid-cols-4">
        {[
          ["VERIFIED SUPPLY", gate.verifiedSupply, "在庫・注文可"],
          ["IDENTITY LINKED", gate.identityLinked, "識別子確認済み"],
          ["TEST READY", gate.opportunityReady, "公開ゲート到達"],
          ["PUBLISHED", gate.published, "ストア掲載中"],
        ].map(([label, value, note]) => (
          <div key={String(label)} className="bg-[#080b0e] p-5 sm:p-6">
            <p className="font-mono text-[8px] tracking-[.22em] text-zinc-600">{label}</p>
            <p className="mt-2 text-3xl font-light tracking-[-0.04em] text-zinc-100">{value}</p>
            <p className="mt-2 text-[10px] text-zinc-600">{note}</p>
          </div>
        ))}
      </section>

      <section className="mt-6 overflow-hidden border border-cyan-400/10 bg-[radial-gradient(circle_at_10%_0%,rgba(34,211,238,.08),transparent_35%)]">
        <div className="flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="font-mono text-[8px] tracking-[.22em] text-cyan-300/70">PUBLICATION PATH</p>
            <p className="mt-2 text-sm text-zinc-200">供給確認 → 識別子 → 需要 / 市場 / 利益 → TEST_READY → Sales Test Gate → 公開</p>
          </div>
          <div className="font-mono text-[9px] tracking-[.16em] text-zinc-600">NO GATE BYPASS</div>
        </div>
      </section>

      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}

      <section className="mt-10 space-y-4">
        <header className="flex flex-col gap-2 border-b border-white/10 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-cyan-300/80">Canonical Commerce / Live Channels</p>
            <h2 className="mt-2 text-2xl font-medium text-zinc-50">BASE・Shopify 自動販売カタログ</h2>
            <p className="mt-2 text-xs leading-6 text-zinc-400">販売中の商品だけでなく、未掲載・掲載失敗・停止済みの商品も履歴として表示します。入れ替え時に仕入先SKU・原価・送料・在庫・各ストアの掲載状態を比較できます。この画面では商品を削除・入れ替えしません。</p>
          </div>
          <p className="font-mono text-[10px] text-zinc-500">{commerceProducts.length} PRODUCTS / {commerceVariants.length} VARIANTS / {commerceListings.filter((row) => row.status === "published").length} PUBLISHED</p>
        </header>
        {commerceProducts.length === 0 ? (
          <p className="border border-dashed border-white/10 p-6 text-sm text-zinc-500">正本カタログは空です。CJ取り込みcronの実行結果を確認してください。</p>
        ) : commerceProducts.map((product) => {
          const variants = commerceVariants.filter((variant) => variant.product_id === product.id);
          return (
            <article key={product.id} className="border border-white/10 bg-[#080b0e] p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-medium text-zinc-100">{product.title_ja}</h3><span className={product.active ? "border border-cyan-400/20 px-2 py-1 font-mono text-[8px] tracking-[.14em] text-cyan-200" : "border border-amber-400/20 px-2 py-1 font-mono text-[8px] tracking-[.14em] text-amber-300"}>{product.active ? "ACTIVE / 販売候補" : "INACTIVE / 停止・入替候補"}</span></div>
                  <p className="mt-1 text-xs text-zinc-500">{product.description_ja || "説明なし"}</p>
                </div>
                <span className="font-mono text-[9px] text-zinc-600">{variants.length} VARIANTS</span>
              </div>
              <div className="mt-4 space-y-3">
                {variants.map((variant) => {
                  const price = commercePrices.find((item) => item.variant_id === variant.id);
                  const offer = price ? freshOfferByIdForDisplay(commerceOffers, price.supplier_offer_id, variant.id) : null;
                  const variantListings = commerceListings.filter((listing) => listing.variant_id === variant.id);
                  return (
                    <div key={variant.id} className="border border-white/8 bg-black/20 p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm text-zinc-200">{variant.title_ja || product.title_ja}</p>
                          <p className="mt-1 font-mono text-[9px] text-zinc-600">SKU {variant.sku || variant.source_variant_key}</p>
                        </div>
                        <div className="text-left sm:text-right">
                          <p className="text-sm text-cyan-200">{price ? "¥" + Math.round(Number(price.selling_price)).toLocaleString("ja-JP") : "価格未計算"}</p>
                          <p className="mt-1 text-xs text-zinc-500">{price ? "想定利益 ¥" + Math.round(Number(price.expected_profit)).toLocaleString("ja-JP") : "利益未計算"}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-xs text-zinc-500">
                        仕入先 {offer?.supplier_code ?? "未確認"} · 在庫 {offer?.inventory ?? "不明"} · 配送先 {offer?.ship_to ?? "不明"} · 仕入先状態 {offer?.source_status ?? "未確認"}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {variantListings.map((listing) => (
                          <div key={listing.id} className="border border-white/8 px-3 py-2 text-[10px]">
                            <span className={listing.status === "published" ? "text-cyan-200" : listing.status === "error" ? "text-amber-300" : "text-zinc-400"}>
                              {listing.channel.toUpperCase()} · {listing.status.toUpperCase()}
                            </span>
                            <span className="ml-2 text-zinc-500">{listing.external_product_id || "外部ID未保存"}</span>
                            {listing.last_error ? <p className="mt-1 max-w-xl text-amber-300">{listing.last_error}</p> : null}
                            {listing.published_url && /^https?:\/\//i.test(listing.published_url) ? (
                              <a className="ml-2 text-cyan-200 hover:text-cyan-100" href={listing.published_url} target="_blank" rel="noreferrer">商品ページ ↗</a>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </section>

      <section className="mt-12">
        <header className="mb-5 border-b border-white/10 pb-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-zinc-600">Legacy Intelligence / Reference Only</p>
          <h2 className="mt-2 text-xl font-medium text-zinc-200">旧パイプラインの参照データ</h2>
          <p className="mt-2 text-xs text-zinc-500">以下の一覧は旧テーブルの診断用です。BASE・Shopifyへの実掲載数は上の正本カタログを参照してください。</p>
        </header>
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
              <article key={product.product_id} className="group border border-white/8 bg-[#080b0e] p-5 transition-colors hover:border-white/14 sm:p-6">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium tracking-[-0.01em] text-zinc-100">{product.normalized_title}</p>
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
                      {product.brand_name ?? "NO BRAND"}
                      {product.current_price !== null && product.currency ? ` / ${product.currency} ${product.current_price}` : " / PRICE UNKNOWN"}
                    </p>
                  </div>
                  <span className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{product.product_id}</span>
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
                    <span className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{listings.length} LISTING{listings.length === 1 ? "" : "S"}</span>
                  </div>
                  {listings.length === 0 ? (
                    <p className="mt-3 border border-dashed border-white/8 px-4 py-4 text-xs text-zinc-600">掲載なし。Sales Test Gate / 供給確認の完了待ち。</p>
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
                              <Link href={`/shop/${listing.slug}`} className="shrink-0 font-mono text-[9px] tracking-[.15em] text-zinc-500 hover:text-cyan-200">STORE ↗</Link>
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
      </section>
    </main>
  );
}
