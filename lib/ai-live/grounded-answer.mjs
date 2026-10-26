/**
 * Conservative Japanese response builder for AI-live product comments.
 * Only states facts present in the minimized product-feed record. No network,
 * model calls, commerce writes, or promises about delivery/quality.
 */
const yen = (value) => new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
}).format(value);

export function answerProductComment(comment, product) {
  const text = typeof comment === "string" ? comment.trim() : "";
  if (!text) return { answer: "コメントありがとうございます。商品について、もう少し詳しく教えてください。", grounded: true, needsHuman: false };

  const title = typeof product?.title === "string" ? product.title.trim() : "";
  if (!title || !Number.isFinite(product?.sellingPrice) || product.sellingPrice <= 0) {
    return { answer: "商品情報を確認できないため、正確にご案内できません。商品ページをご確認ください。", grounded: false, needsHuman: true };
  }

  if (/いくら|価格|値段|何円|金額/.test(text)) {
    return { answer: `${title}の表示価格は${yen(product.sellingPrice)}です。最新の価格は商品ページでご確認ください。`, grounded: true, needsHuman: false };
  }
  if (/在庫|ありますか|まだ買え|売り切れ/.test(text)) {
    if (product.inStock === true) return { answer: `${title}は、現在の登録情報では在庫ありです。ご注文前に商品ページで最新状況をご確認ください。`, grounded: true, needsHuman: false };
    if (product.inStock === false) return { answer: `${title}は、現在の登録情報では在庫切れです。`, grounded: true, needsHuman: false };
    return { answer: "最新の在庫状況を確認できません。商品ページをご確認ください。", grounded: false, needsHuman: true };
  }
  if (/いつ届|何日で届|配送|送料|明日届|到着/.test(text)) {
    return { answer: "この配信画面では配送日や送料を確約できません。商品ページの配送案内をご確認ください。", grounded: false, needsHuman: true };
  }
  if (/どこで買|購入|商品ページ|リンク/.test(text)) {
    try {
      const url = new URL(product.productUrl);
      if (url.origin === "https://tracer.base.ec" && url.pathname.startsWith("/items/")) {
        return { answer: `${title}の商品ページはこちらです：${url.href}`, grounded: true, needsHuman: false };
      }
    } catch {}
    return { answer: "購入先URLを安全に確認できません。TRACERの商品一覧からご確認ください。", grounded: false, needsHuman: true };
  }
  if (/どんな|特徴|説明|素材|サイズ|色|使い方/.test(text)) {
    const description = typeof product.description === "string" ? product.description.trim() : "";
    if (description) return { answer: `${title}について、登録されている説明は「${description}」です。詳しい仕様は商品ページをご確認ください。`, grounded: true, needsHuman: false };
    return { answer: "詳しい仕様を確認できる説明が登録されていません。商品ページをご確認ください。", grounded: false, needsHuman: true };
  }
  return { answer: "コメントありがとうございます。価格・在庫・商品説明についてお答えできます。配送日など確認できない内容は商品ページでご確認ください。", grounded: true, needsHuman: false };
}
