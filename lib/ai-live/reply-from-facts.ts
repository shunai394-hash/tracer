export type VerifiedAiLiveProductFacts = {
  title: string;
  description: string | null;
  sellingPrice: number;
  currency: string;
  inStock: boolean;
  productUrl: string;
};

export type AiLiveReplyResult =
  | { action: "speak_verified_reply"; text: string }
  | { action: "human_handoff"; reason: string };

/**
 * Creates short Japanese replies only from fields already verified by the
 * authenticated listing endpoint. Never guesses shipping dates, variants,
 * discounts, or product properties.
 */
export function buildAiLiveReply(
  category: string,
  product: VerifiedAiLiveProductFacts,
): AiLiveReplyResult {
  if (!product.title.trim() || !Number.isFinite(product.sellingPrice) || product.sellingPrice <= 0) {
    return { action: "human_handoff", reason: "invalid_verified_product_facts" };
  }

  switch (category) {
    case "price":
      return {
        action: "speak_verified_reply",
        text: `${product.title}は${product.sellingPrice.toLocaleString("ja-JP")}円です。送料や最新の販売条件は商品ページでご確認ください。`,
      };
    case "stock_or_variant":
      return product.inStock
        ? { action: "speak_verified_reply", text: `${product.title}は現在、在庫ありとして確認できています。色やサイズなどの選択肢は商品ページでご確認ください。` }
        : { action: "human_handoff", reason: "stock_not_verified" };
    case "purchase":
      return {
        action: "speak_verified_reply",
        text: `${product.title}はこちらの商品ページからご確認いただけます。${product.productUrl}`,
      };
    case "product_faq":
      return product.description?.trim()
        ? { action: "speak_verified_reply", text: `${product.title}について、登録されている商品説明をご案内します。${product.description.slice(0, 700)}` }
        : { action: "human_handoff", reason: "verified_description_unavailable" };
    case "shipping":
      return { action: "human_handoff", reason: "delivery_estimate_not_available" };
    default:
      return { action: "human_handoff", reason: "category_not_approved_for_auto_reply" };
  }
}
