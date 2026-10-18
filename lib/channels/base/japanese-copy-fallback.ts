import {
  isJapaneseProductDescription,
  isJapaneseProductTitle,
  localizeProductDescription,
  localizeProductTitle,
} from "../../intelligence/japanese-product.ts";

export type JapaneseCopy = { title: string; detail: string };

function hasJapaneseCopy(value: string): boolean {
  if (!/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(value)) return false;
  const japanese = (value.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return latin <= Math.max(12, japanese * 1.5);
}

/**
 * Build a fallback only when the repository's source-grounded localization
 * rules can identify a Japanese title and the resulting copy passes language
 * validation. Ambiguous titles such as a color or brand alone remain blocked.
 */
export function deterministicJapaneseCopy(title: string, detail: string): JapaneseCopy | null {
  const cleanTitle = title.trim();
  const cleanDetail = detail.trim();
  // A lone brand/model or variant label is not enough evidence to identify a
  // product. In particular, do not turn "Blue" into a fabricated product title.
  const colorOnly = /^(?:blue|red|green|black|white|yellow|pink|purple|orange|brown|grey|gray|beige|navy|silver|gold|reddish brown|dark brown|light brown)$/i;
  if (!cleanDetail && (/^[A-Za-z][A-Za-z0-9-]*$/.test(cleanTitle) || colorOnly.test(cleanTitle))) {
    return null;
  }
  const sourceCopy = cleanTitle + "\\n" + cleanDetail;
  const fallbackTitle = localizeProductTitle(sourceCopy, title);
  if (!fallbackTitle || !isJapaneseProductTitle(fallbackTitle) || !hasJapaneseCopy(fallbackTitle)) {
    return null;
  }
  const fallbackDetail =
    localizeProductDescription(sourceCopy) ??
    "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。";
  if (!isJapaneseProductDescription(fallbackDetail)) return null;
  return { title: fallbackTitle, detail: fallbackDetail };
}
