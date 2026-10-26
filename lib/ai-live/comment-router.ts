export type AiLiveCommentCategory =
  | "order_support"
  | "complaint_or_return"
  | "price"
  | "stock_or_variant"
  | "shipping"
  | "purchase"
  | "product_faq"
  | "spam_or_abuse"
  | "unknown";

export type AiLiveCommentRoute = {
  category: AiLiveCommentCategory;
  action: "answer_from_verified_facts" | "human_handoff" | "ignore_or_moderate";
  reason: string;
};

/**
 * Conservative, deterministic routing for Japanese livestream comments.
 * This classifies only; it never invents an answer or accesses order/customer data.
 * Human-sensitive categories take precedence over ordinary product keywords.
 */
export function routeAiLiveComment(rawText: unknown): AiLiveCommentRoute {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return { category: "unknown", action: "human_handoff", reason: "empty_or_invalid_comment" };
  }

  const text = rawText.normalize("NFKC").toLowerCase().slice(0, 2000);

  if (/(死ね|殺す|消えろ|くたばれ|暴言|スパム|宣伝リンク|仮想通貨|カジノ)/u.test(text)) {
    return { category: "spam_or_abuse", action: "ignore_or_moderate", reason: "abuse_or_spam_signal" };
  }

  if (/(返品|返金|クレーム|苦情|壊れて|不良品|届かない|キャンセル|交換したい)/u.test(text)) {
    return { category: "complaint_or_return", action: "human_handoff", reason: "complaint_requires_support" };
  }

  if (/(注文番号|注文した|注文状況|配送状況|追跡番号|荷物はどこ|購入履歴|私の注文)/u.test(text)) {
    return { category: "order_support", action: "human_handoff", reason: "personal_order_data_requires_authenticated_support" };
  }

  if (/(治る|治療|副作用|病気|医療|安全性|子供.*使|妊娠|アレルギー|肌荒れ)/u.test(text)) {
    return { category: "unknown", action: "human_handoff", reason: "health_or_safety_claim_requires_review" };
  }

  if (/(いくら|価格|値段|何円|税込|送料込み|送料無料)/u.test(text)) {
    return { category: "price", action: "answer_from_verified_facts", reason: "use_current_verified_product_price_and_shipping_only" };
  }

  if (/(在庫|ありますか|売り切れ|残り|色|サイズ|型番|バリエーション)/u.test(text)) {
    return { category: "stock_or_variant", action: "answer_from_verified_facts", reason: "recheck_current_stock_and_variant_before_answering" };
  }

  if (/(いつ届|何日で届|明日届|配送|発送|お届け|到着)/u.test(text)) {
    return { category: "shipping", action: "answer_from_verified_facts", reason: "answer_only_if_current_delivery_estimate_is_available" };
  }

  if (/(どこで買|購入方法|買いたい|商品ページ|リンク|url|買えますか)/u.test(text)) {
    return { category: "purchase", action: "answer_from_verified_facts", reason: "share_canonical_product_url_only" };
  }

  if (/(どんな商品|特徴|使い方|素材|サイズ|重さ|何が入|セット内容|違い|比較)/u.test(text)) {
    return { category: "product_faq", action: "answer_from_verified_facts", reason: "answer_only_from_approved_product_facts" };
  }

  return { category: "unknown", action: "human_handoff", reason: "no_safe_rule_match" };
}
