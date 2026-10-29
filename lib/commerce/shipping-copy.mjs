/**
 * One customer-facing shipping sentence across TRACER product descriptions.
 * Do not claim free/included shipping unless the destination checkout confirms it.
 */
export const CANONICAL_SHIPPING_COPY = "送料・配送条件は購入手続き画面でご確認ください。";

export function normalizeShippingCopy(description) {
  const text = String(description ?? "");
  const cleaned = text
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line && !/(?:送料別|送料別途|送料込み|送料無料|送料は商品価格に含まれています|日本向け送料\s*[：:]|配送費用は決済画面|送料・配送条件は購入手続き画面でご確認ください)/u.test(line))
    .join("\n\n")
    .trim();
  return [cleaned, CANONICAL_SHIPPING_COPY].filter(Boolean).join("\n\n");
}
