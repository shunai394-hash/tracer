// Storefront title hygiene shared by every channel (Shopify, BASE, and the
// NEWFIND promotions built from them). These rules only remove copy that is
// demonstrably wrong; they never invent product facts.

const COLOR_WORDS = new Set([
  "ブラック", "ホワイト", "ピンク", "ブラウン", "ブルー", "グリーン", "パープル", "ゴールド", "シルバー",
  "レッド", "グレー", "ベージュ", "カーキ", "イエロー", "オレンジ", "アプリコット", "ネイビー", "ローズレッド",
]);

// Beauty-tool modifiers that the CJ importer could attach to unrelated
// products (for example "眉メイク用 レディースショルダーバッグ").
export const BEAUTY_TOOL_MODIFIERS = [
  "眉メイク用", "まつげ用", "フェイスケア用", "毛穴ケア用", "ネイルケア用", "電動クリーナー", "お手入れ用品", "サロン用",
] as const;

const BAG_WORD = /バッグ|トート|ポーチ/u;

// Exact source strings that were published half-translated.
const EXACT_TITLE_FIXES: Array<[RegExp, string]> = [
  [/^コスメ\s*ブラシ\s*Cleaner$/iu, "メイクブラシクリーナー"],
];

/** Drop beauty-tool modifiers from bag titles; keep them for real beauty tools. */
export function filterModifiersForCore(modifiers: string[], core: string): string[] {
  if (!BAG_WORD.test(core)) return modifiers;
  const blocked = new Set<string>(BEAUTY_TOOL_MODIFIERS);
  return modifiers.filter((label) => !blocked.has(label));
}

/**
 * A colour prefix is only safe when every variant shares one colour. With
 * several colours the prefix contradicts each variant's own colour suffix
 * (e.g. "ブラック・ピンク レディースハンドバッグ（ブルー）").
 */
export function singleVariantColor(colors: string[]): string | null {
  const distinct = [...new Set(colors)];
  return distinct.length === 1 ? distinct[0] : null;
}

export function normalizeListingTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let title = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!title) return "";

  for (const [pattern, replacement] of EXACT_TITLE_FIXES) {
    if (pattern.test(title)) return replacement;
  }

  // "(グレー)（グレー）" / "（グレー）（グレー）" → "（グレー）"
  title = title.replace(/[(（]([^()（）]+)[)）]\s*（\1）$/u, "（$1）");
  // Category placeholder that slipped through as a product name.
  title = title.replace(/^バッグ・収納アイテム(?=（|$)/u, "レディースバッグ");

  if (BAG_WORD.test(title)) {
    for (const modifier of BEAUTY_TOOL_MODIFIERS) {
      title = title
        .replace(new RegExp(`・${modifier}(?=[\\s・])`, "gu"), "")
        .replace(new RegExp(`(^|\\s)${modifier}・`, "gu"), "$1")
        .replace(new RegExp(`(^|\\s)${modifier}\\s+`, "gu"), "$1");
    }
    title = title.replace(/\s+/gu, " ").trim();
  }

  // Leading colour-only prefix.
  const prefixed = title.match(/^(\S+)\s+(.+)$/u);
  if (prefixed) {
    const colors = prefixed[1].split("・");
    const colorOnly = colors.length > 0 && colors.every((word) => COLOR_WORDS.has(word));
    const hasSuffix = /（[^）]+）$/u.test(prefixed[2]);
    if (colorOnly && colors.length > 1 && BAG_WORD.test(prefixed[2])) {
      // Several colours describe a two-tone design, not this variant's colour.
      title = `配色デザイン ${prefixed[2]}`;
    } else if (colorOnly && hasSuffix) {
      // The variant suffix already names the colour; a different (or repeated)
      // prefix colour is contradictory or redundant.
      title = prefixed[2];
    }
  }
  return title;
}

/**
 * A manually curated title replaces the generated one, but each variant keeps
 * its own colour/size suffix so variants stay distinguishable.
 */
export function applyManualTitle(manual: string, variantTitle: unknown): string {
  const base = normalizeListingTitle(manual);
  if (!base) return "";
  if (/（[^）]+）/u.test(base)) return base;
  const suffix = typeof variantTitle === "string" ? variantTitle.match(/（[^）]*）$/u)?.[0] ?? "" : "";
  if (!suffix) return base;
  const bar = base.indexOf("｜");
  return bar === -1 ? base + suffix : base.slice(0, bar) + suffix + base.slice(bar);
}
