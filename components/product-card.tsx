import Link from "next/link";
import type { ShopListing } from "@/lib/shop/store";
import { formatMoney } from "@/lib/intelligence/format-display";
import { ProductImage } from "@/components/product-image";

export function ProductCard({ listing, priority = false }: { listing: ShopListing; priority?: boolean }) {
  const lowStock = listing.inventory > 0 && listing.inventory <= 5;

  return (
    <Link
      href={`/shop/${listing.id}`}
      aria-label={`${listing.title}、${formatMoney(listing.sellingPrice, listing.currency)}、${listing.inventory > 0 ? (listing.inventory <= 5 ? "残りわずか" : "在庫あり") : "在庫切れ"}、商品詳細を見る`}
      className="group block rounded-2xl outline-none transition-transform duration-300 focus-visible:ring-2 focus-visible:ring-[#9A6B5B] focus-visible:ring-offset-4 focus-visible:ring-offset-[#FBF6F1] motion-reduce:transition-none"
    >
      <div className="relative overflow-hidden rounded-2xl bg-[#F4ECE6]">
        {listing.inventory <= 0 ? (
          <span className="absolute left-3 top-3 z-10 rounded-full bg-[#3B241A]/90 px-3 py-1.5 text-[11px] font-medium tracking-wide text-white">在庫切れ</span>
        ) : null}
        <ProductImage
          src={listing.imageUrl}
          alt={listing.title}
          eager={priority}
          className="aspect-[4/5] w-full object-cover transition duration-700 ease-out group-hover:scale-[1.045] group-focus-visible:scale-[1.025] motion-reduce:transition-none"
        />
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-[#2C1B15]/55 to-transparent px-3 pb-3 pt-12 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
          <span className="text-[11px] font-medium tracking-[0.08em] text-white">商品を見る</span>
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full border border-white/70 text-white">↗</span>
        </div>
      </div>
      <div className="px-1.5 pb-2 pt-3.5">
        <h3 className="line-clamp-2 min-h-10 text-[13px] leading-5 text-[#3B241A] transition-colors group-hover:text-[#8A5948] group-focus-visible:text-[#8A5948] sm:text-sm">
          {listing.title}
        </h3>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-base font-semibold tracking-tight text-[#3B241A] sm:text-lg">
            {formatMoney(listing.sellingPrice, listing.currency)}
          </p>
          <span className="text-[10px] text-[#7D675D]">税込・送料込み</span>
        </div>
        <div className="mt-2 flex min-h-5 items-center justify-between gap-2">
          <span className="text-[11px] tracking-[0.04em] text-[#9A6B5B]">TRACER SELECT</span>
          <span className={lowStock ? "text-[11px] font-medium text-[#A33E50]" : "text-[11px] text-[#7D675D]"}>
            {lowStock ? "残りわずか" : listing.inventory > 0 ? "在庫あり" : "在庫切れ"}
          </span>
        </div>
      </div>
    </Link>
  );
}
