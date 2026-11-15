"use client";

import { useMemo, useState } from "react";
import { AddToCartButton } from "@/components/add-to-cart-button";
import { ProductImage } from "@/components/product-image";
import type { ColorFamilyChoice } from "@/lib/shop/color-family-storefront";
import type { ShopListing } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";

export function ProductVariantSelector({
  listing,
  variants,
  categoryLabel,
  shopifyDomain,
  saleBlocked,
}: {
  listing: ShopListing;
  variants: ColorFamilyChoice[];
  categoryLabel: string | null;
  shopifyDomain: string;
  saleBlocked: boolean;
}) {
  const choices = useMemo(() => {
    if (variants.length > 0) return variants;
    return [{
      id: listing.id,
      slug: listing.slug,
      title: listing.title,
      label: "",
      imageUrl: listing.imageUrl,
      sellingPrice: listing.sellingPrice,
      currency: listing.currency,
      inventory: listing.inventory,
      sku: listing.sku ?? null,
      supplierProductId: listing.supplierProductId,
      supplierVariantId: listing.supplierVariantId,
      shopifyVariantId: listing.shopifyVariantId,
      shopifyHandle: listing.shopifyHandle,
    } satisfies ColorFamilyChoice];
  }, [listing, variants]);
  const initialId = listing.selectedVariantId && choices.some((choice) => choice.id === listing.selectedVariantId)
    ? listing.selectedVariantId
    : listing.id;
  const [selectedId, setSelectedId] = useState(initialId);
  const selected = choices.find((choice) => choice.id === selectedId) ?? choices[0];
  const variantNumber = selected.shopifyVariantId?.match(/ProductVariant\/(\d+)$/)?.[1];
  const shopifyUrl = !saleBlocked && selected.shopifyHandle && variantNumber && shopifyDomain
    ? `https://${shopifyDomain}/products/${encodeURIComponent(selected.shopifyHandle)}?variant=${variantNumber}`
    : null;
  const colorFamily = variants.length > 1;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-12">
      <div className="md:sticky md:top-24 md:self-start">
        <div className="overflow-hidden rounded-2xl bg-[#F4ECE6]">
          {selected.imageUrl ? (
            <ProductImage src={selected.imageUrl} alt={selected.label ? `${listing.title} ${selected.label}` : listing.title} eager className="aspect-[4/5] w-full object-cover" />
          ) : (
            <div className="flex aspect-[4/5] w-full items-center justify-center px-6 text-center text-sm text-neutral-500">このカラーの画像は確認できません</div>
          )}
        </div>
      </div>
      <div>
        {categoryLabel ? <p className="text-[11px] tracking-[0.3em] text-[#9A6B5B]">{categoryLabel}</p> : null}
        <h1 className="mt-2 font-serif text-2xl leading-snug sm:text-[28px]">{listing.title}</h1>
        {colorFamily ? (
          <section className="mt-6" aria-label="カラー選択">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-[#3B241A]">カラーを選択</h2>
              <span className="text-sm text-[#5C4035]">選択中：{selected.label || "未確認"}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {choices.map((choice) => (
                <button key={choice.id} type="button" onClick={() => setSelectedId(choice.id)} aria-pressed={selected.id === choice.id} className={`min-h-11 rounded-full border px-4 py-2 text-sm ${selected.id === choice.id ? "border-[#3B241A] bg-[#3B241A] text-white" : "border-[#D9C8BE] bg-white text-[#3B241A]"}`}>
                  {choice.label || "未確認"}
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
          {saleBlocked ? (
            <div role="status" className="rounded-xl border border-[#D9C8BE] bg-white px-4 py-4 text-center text-sm leading-6 text-[#5C4035]">
              色ごとの画像・SKU・価格・在庫を確認できないため、この商品は現在購入できません。
            </div>
          ) : shopifyUrl ? (
            <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-12 w-full items-center justify-center rounded-full bg-[#3B241A] px-6 py-4 text-sm font-medium text-white">
              {colorFamily ? "選択したカラーを購入する" : "Shopifyで購入する"}
            </a>
          ) : (
            <AddToCartButton
              listingId={selected.id}
              slug={selected.slug}
              title={listing.title}
              colorLabel={selected.label || null}
              sku={selected.sku}
              supplierVariantId={selected.supplierVariantId}
              unitPrice={selected.sellingPrice}
              currency={selected.currency}
              imageUrl={selected.imageUrl}
            />
          )}
          <p className="mt-3 text-center text-xs leading-5 text-neutral-500">
            {colorFamily ? "選択したカラーのSKU・価格・在庫を注文に引き継ぎます。" : "注文内容・配送条件は、購入手続き画面でご確認ください。"}
          </p>
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
