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

// Classify by product intent, not incidental words. In particular, beauty tools
// often contain "クリップ" or "ピンセット"; these must not leak into hair goods.
// Keep the order explicit because supplier titles are inconsistent and Japanese
// product names frequently combine several category keywords.
export function categoryOf(title: string): StorefrontCategory["slug"] {
  const normalized = title.normalize("NFKC").toLocaleLowerCase();

  // Beauty and grooming tools take precedence over generic "クリップ"/"ポーチ".
  if (
    /ニキビ|毛穴|角栓|ピンセット|毛抜き|ビューラー|アイラッシュ|まつげ|アイブロウ|眉毛|ネイル|化粧|メイク|コスメ|メイクブラシ|化粧ブラシ|メイクスポンジ|パフ|ファンデーション|コンシーラー|美容ツール|フェイスローラー|かみそり|シェーバー/.test(normalized)
  ) return "makeup";

  if (/ハンドバッグ|ショルダーバッグ|クロスボディ|トートバッグ|リュック|バックパック|バッグ|かばん|鞄/.test(normalized)) return "bags";

  if (
    /ヘアアクセサリー|ヘアクリップ|バンスクリップ|髪留め|髪飾り|ヘアピン|ヘアゴム|バレッタ|シュシュ|カチューシャ|ヘアバンド|ヘアコーム|かんざし|簪|まとめ髪/.test(normalized)
  ) return "hair";

  // A plain pouch is a bag only when it is not clearly a beauty tool (handled above).
  if (/ポーチ/.test(normalized)) return "bags";
  if (/ブラシ|コスメ|メイク|化粧/.test(normalized)) return "makeup";
  return "other";
}

// Title without the trailing colour/variant in parentheses, e.g. "…バッグ（ピンク）".
export function variantFamily(title: string): string {
  return title.normalize("NFKC").replace(/\s*[（(]\s*(?:ブラック|黒|ホワイト|白|アイボリー|ベージュ|ブラウン|茶|グレー|灰色|グレージュ|ネイビー|紺|ブルー|青|ライトブルー|グリーン|緑|カーキ|レッド|赤|ピンク|パープル|紫|オレンジ|イエロー|黄|シルバー|銀|ゴールド|金|black|white|ivory|beige|brown|gray|grey|navy|blue|green|khaki|red|pink|purple|orange|yellow|silver|gold)\s*[）)]\s*$/i, "").trim().toLocaleLowerCase();
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
  lifestyle: "https://d2ol7oe51mr4n1VMC05NhTNVQsVbou/72bf7497-f78e-48b8-a2eb-401478ac8998.webp",
};
