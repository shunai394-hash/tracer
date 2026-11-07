"use client";

import { useMemo, useState } from "react";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { ProductImage } from "@/components/product-image";
import type { ShopListing, ShopVariantOption } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";

export function ProductVariantSelector({
  listing,
  variants,
  categoryLabel,
  shopifyDomain,
}: {
  listing: ShopListing;
  variants: ShopVariantOption[];
  categoryLabel: string | null;
  shopifyDomain: string;
}) {
  const choices = useMemo(() => {
    const rows = variants.length > 0 ? variants : [{
      id: listing.id,
      slug: listing.slug,
      title: listing.title,
      label: listing.variantLabel || "標準",
      optionType: listing.variantOptionType ?? "種類",
      imageUrl: listing.imageUrl,
      sellingPrice: listing.sellingPrice,
      currency: listing.currency,
      inventory: listing.inventory,
      supplierVariantId: listing.supplierVariantId,
      shopifyVariantId: listing.shopifyVariantId,
      shopifyHandle: listing.shopifyHandle,
    }];
    return rows;
  }, [listing, variants]);
  const [selectedId, setSelectedId] = useState(listing.id);
  const selected = choices.find((choice) => choice.id === selectedId) ?? choices[0];
  const variantNumber = selected.shopifyVariantId?.match(/ProductVariant\/(\d+)$/)?.[1];
  const shopifyUrl = selected.shopifyHandle && variantNumber && shopifyDomain
    ? `https://${shopifyDomain}/products/${encodeURIComponent(selected.shopifyHandle)}?variant=${variantNumber}`
    : null;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-12">
      <div className="md:sticky md:top-24 md:self-start">
        <div className="overflow-hidden rounded-2xl bg-[#F4ECE6]">
          <ProductImage src={selected.imageUrl || listing.imageUrl} alt={`${listing.title} ${selected.label}`} eager className="aspect-[4/5] w-full object-cover transition-opacity duration-200" />
        </div>
        {choices.length > 1 ? (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {choices.map((choice) => (
              <button key={choice.id} type="button" onClick={() => setSelectedId(choice.id)} aria-label={`${choice.label}を選択`} aria-pressed={selected.id === choice.id} className={`overflow-hidden rounded-xl border-2 bg-white text-left transition ${selected.id === choice.id ? "border-[#3B241A]" : "border-transparent"}`}>
                <ProductImage src={choice.imageUrl || listing.imageUrl} alt={choice.label} className="aspect-square w-full object-cover" />
                <span className="block truncate px-2 py-1.5 text-center text-xs text-[#3B241A]">{choice.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        {categoryLabel ? <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">{categoryLabel}</p> : null}
        <h1 className="mt-2 font-serif text-2xl leading-snug sm:text-[28px]">{listing.title}</h1>
        {choices.length > 1 ? (
          <section className="mt-6" aria-label={`${choices[0].optionType}選択`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-[#3B241A]">{choices[0].optionType}を選択</h2>
              <span className="text-sm text-[#5C4035]">選択中：{selected.label}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {choices.map((choice) => (
                <button key={choice.id} type="button" onClick={() => setSelectedId(choice.id)} aria-pressed={selected.id === choice.id} className={`rounded-full border px-4 py-2 text-sm transition ${selected.id === choice.id ? "border-[#3B241A] bg-[#3B241A] text-white" : "border-[#D9C8BE] bg-white text-[#3B241A] hover:border-[#9A6B5B]"}`}>
                  {choice.label}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <div className="mt-5 flex items-baseline gap-2">
          <p className="text-[28px] font-semibold tracking-tight">{formatMoney(selected.sellingPrice, selected.currency)}</p>
          <span className="text-xs text-neutral-500">表示価格</span>
        </div>
        <p className={selected.inventory > 0 && selected.inventory <= 5 ? "mt-2 text-sm text-[#B84A62]" : "mt-2 text-sm text-[#5C4035]"}>
          {selected.inventory <= 0 ? "在庫切れ" : selected.inventory <= 5 ? `残りわずか（あと${selected.inventory}点）` : "在庫あり"}
        </p>
        <div className="mt-6">
          {shopifyUrl ? (
            <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className="flex w-full items-center justify-center rounded-full bg-[#3B241A] px-6 py-4 text-sm font-medium text-white transition hover:bg-[#5C4035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B] focus-visible:ring-offset-2">
              選択した商品を購入する
            </a>
          ) : (
            <AddToCartButton listingId={selected.id} slug={selected.slug} title={selected.title} unitPrice={selected.sellingPrice} currency={selected.currency} imageUrl={selected.imageUrl || listing.imageUrl} />
          )}
          <p className="mt-3 text-center text-xs leading-5 text-neutral-500">選択したバリエーション・在庫を注文に引き継ぎます。</p>
        </div>
        <ul className="mt-6 grid grid-cols-3 gap-2 text-center text-[11px] leading-4 text-[#5C4035] sm:text-xs">
          <li className="rounded-xl bg-white/70 px-2 py-3">価格・配送条件を<br />購入前に確認</li>
          <li className="rounded-xl bg-white/70 px-2 py-3">配送情報を<br />購入前に確認</li>
          <li className="rounded-xl bg-white/70 px-2 py-3">商品情報を<br />掲載前に確認</li>
        </ul>
      </div>
    </div>
  );
}
