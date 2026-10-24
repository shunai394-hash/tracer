import Link from "next/link";
import type { ShopListing } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { ProductImage } from "@/components/product-image";

export function ProductCard({ listing, priority = false }: { listing: ShopListing; priority?: boolean }) {
  const lowStock = listing.inventory <= 5;

  return (
    <article className="h-full">
      <Link
        href={`/shop/${listing.id}`}
        aria-label={`${listing.title}、価格 ${formatMoney(listing.sellingPrice, listing.currency)}、商品詳細を見る`}
        className="group block h-full rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#9A6B5B]"
      >
        <div className="overflow-hidden rounded-2xl bg-[#F4ECE6]">
          <ProductImage
            src={listing.imageUrl}
            alt={listing.title}
            eager={priority}
            className="aspect-square w-full object-cover transition-transform duration-500 motion-reduce:transition-none group-hover:scale-[1.03]"
          />
        </div>
        <div className="px-1 pt-3">
          <h3 className="line-clamp-2 text-[13px] leading-5 text-neutral-800 decoration-[#9A6B5B] underline-offset-4 group-hover:underline sm:text-sm">
            {listing.title}
          </h3>
          <p className="mt-1.5 text-base font-semibold tabular-nums text-[#3B241A]">
            {formatMoney(listing.sellingPrice, listing.currency)}
            <span className="ml-1 text-[10px] font-normal text-neutral-500">税込</span>
          </p>
          <p className={lowStock ? "mt-1 text-xs font-medium text-[#A33C52]" : "mt-1 text-xs text-neutral-500"}>
            {lowStock ? "残りわずか" : "在庫あり"}
          </p>
        </div>
      </Link>
    </article>
  );
}
