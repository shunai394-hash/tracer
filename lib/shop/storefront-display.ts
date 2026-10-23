import type { ShopListing } from "@/lib/shop/store";

// Presentation-only helpers for storefront pages. They never merge listings:
// every card still links to one real listing, so checkout identity is untouched.

export type StorefrontCategory = {
  slug: "bags" | "hair" | "makeup" | "other";
  label: string;
  lead: string;
};

export const STOREFRONT_CATEGORIES: StorefrontCategory[] = [
  { slug: "bags", label: "バッグ", lead: "毎日持ちたいハンドバッグ・ショルダーバッグ" },
  { slug: "hair", label: "ヘアアクセサリー", lead: "まとめ髪を上品に仕上げるヘアクリップ" },
  { slug: "makeup", label: "メイク小物", lead: "ブラシ収納やお手入れ用品" },
  { slug: "other", label: "その他", lead: "暮らしに寄り添うアイテム" },
];

// Bags are checked first: some bag titles also mention "メイク".
export function categoryOf(title: string): StorefrontCategory["slug"] {
  if (/バッグ|ショルダー|クロスボディ|トート|ポーチ|リュック/.test(title)) return "bags";
  if (/ヘア|クリップ|バレッタ|シュシュ|カチューシャ/.test(title)) return "hair";
  if (/メイク|ブラシ|コスメ/.test(title)) return "makeup";
  return "other";
}

// Title without the trailing colour/variant in parentheses, e.g. "…バッグ（ピンク）".
export function variantFamily(title: string): string {
  return title.normalize("NFKC").replace(/\s*\([^()]*\)\s*$/, "").trim().toLocaleLowerCase();
}

// Pick up to `limit` listings with images, showing one colour per product family
// so rows are not filled with the same bag in different colours.
export function pickDistinct(listings: ShopListing[], limit: number): ShopListing[] {
  const seen = new Set<string>();
  const picked: ShopListing[] = [];
  for (const listing of listings) {
    if (!listing.imageUrl) continue;
    const family = variantFamily(listing.title);
    if (seen.has(family)) continue;
    seen.add(family);
    picked.push(listing);
    if (picked.length >= limit) break;
  }
  return picked;
}

// Brand imagery generated with Higgsfield (GPT Image 2.5) and hosted on its CDN.
export const STOREFRONT_IMAGES = {
  heroWide: "https://d2ol7oe51mr4n9.cloudfront.net/user_3L5iapCiBz1VMC05NhTNVQsVbou/9ea6d5ac-c832-4373-9907-393ddf2b61d9.webp",
  heroTall: "https://d2ol7oe51mr4n9.cloudfront.net/user_3L5iapCiBz1VMC05NhTNVQsVbou/c2d036f8-19df-4a74-9e99-1841a92606a9.webp",
  lifestyle: "https://d2ol7oe51mr4n9.cloudfront.net/user_3L5iapCiBz1VMC05NhTNVQsVbou/72bf7497-f78e-48b8-a2eb-401478ac8998.webp",
};
