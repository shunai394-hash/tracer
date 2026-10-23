import Link from "next/link";
import type { ShopListing } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { ProductImage } from "@/components/product-image";

export function ProductCard({ listing, priority = false }: { listing: ShopListing; priority?: boolean }) {
  return (
    <Link href={`/shop/${listing.id}`} className="group block">
      <div className="overflow-hidden rounded-2xl bg-[#F4ECE6]">
        <ProductImage
          src={listing.imageUrl}
          alt={listing.title}
          eager={priority}
          className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]"
        />
      </div>
      <div className="px-1 pt-3">
        <h3 className="line-clamp-2 text-[13px] leading-5 text-neutral-800 group-hover:underline sm:text-sm">{listing.title}</h3>
        <p className="mt-1.5 text-base font-semibold text-[#3B241A]">
          {formatMoney(listing.sellingPrice, listing.currency)}
          <span className="ml-1 text-[10px] font-normal text-neutral-500">税込</span>
        </p>
        <p className={listing.inventory <= 5 ? "mt-0.5 text-xs text-[#B84A62]" : "mt-0.5 text-xs text-neutral-500"}>
          {listing.inventory <= 5 ? "残りわずか" : "在庫あり"}
        </p>
      </div>
    </Link>
  );
}
