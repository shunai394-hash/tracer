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

// Importer category words stacked on top of each other
// ("電動クリーナー・お手入れ用品 メイクブラシ・お手入れ用品").
const STACKED_TITLE_FIXES: Array<[RegExp, string]> = [
  [/(^|・|\s)電動クリーナー(?:・お手入れ用品)?\s+メイクブラシ・お手入れ用品/u, "$1電動メイクブラシクリーナー"],
  [/(^|・|\s)お手入れ用品\s+メイクブラシ・お手入れ用品/u, "$1メイクブラシお手入れ用品"],
  [/(^|\s)電動クリーナー・お手入れ用品\s+/u, "$1"],
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

  for (const [pattern, replacement] of STACKED_TITLE_FIXES) title = title.replace(pattern, replacement);
  // "猫モチーフ・電動メイクブラシクリーナー" reads better with a space.
  title = title.replace(/・(電動メイクブラシクリーナー|メイクブラシお手入れ用品)/u, " $1").trim();

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
    if (colorOnly && colors.length > 1) {
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
  // Only a colour suffix distinguishes variants; other generated suffixes
  // (e.g. "（寝ながらカール）") would just repeat the curated wording.
  const suffixWords = suffix.slice(1, -1).split("・");
  if (!suffix || !suffixWords.every((word) => COLOR_WORDS.has(word))) return base;
  const bar = base.indexOf("｜");
  return bar === -1 ? base + suffix : base.slice(0, bar) + suffix + base.slice(bar);
}

// Every TRACER price already includes Japan-bound shipping. One sentence, said
// the same way on every storefront, replaces all older shipping copy.
export const FREE_SHIPPING_SENTENCE = "送料込み・送料無料。日本向け送料は商品価格に含まれています。";
const SHIPPING_SENTENCE = /[^。！？\n<>]*(?:送料別|送料別途|送料込み|送料無料|送料は商品価格に含まれています|日本向け送料[：:]|配送費用は決済画面)[^。！？\n<>]*[。！？]?/gu;

/** Plain-text description with exactly one free-shipping sentence at the end. */
export function freeShippingText(description: unknown): string {
  const cleaned = String(description ?? "")
    .replace(SHIPPING_SENTENCE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [cleaned, FREE_SHIPPING_SENTENCE].filter(Boolean).join("\n\n");
}

/** Same rule for an HTML description (Shopify). Returns null when already clean. */
export function freeShippingHtml(html: unknown): string | null {
  const raw = String(html ?? "");
  // Plain text stored as HTML loses its line breaks; give it paragraphs.
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const source = /<[a-z][^>]*>/i.test(raw)
    ? raw
    : raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => "<p>" + escape(block).replace(/\n/g, "<br>") + "</p>").join("\n");
  const parts = source.split(FREE_SHIPPING_SENTENCE);
  if (source === raw && parts.length === 2 && !(parts.join("").match(SHIPPING_SENTENCE) ?? []).length) return null;
  let cleaned = source.replace(SHIPPING_SENTENCE, "");
  // Drop wrappers and line breaks left empty by the removal.
  for (let i = 0; i < 3; i += 1) {
    cleaned = cleaned
      .replace(/<(p|div|li|span)[^>]*>\s*(?:<br\s*\/?>\s*)*<\/\1>/giu, "")
      .replace(/(?:<br\s*\/?>\s*)+$/iu, "")
      .replace(/(?:<br\s*\/?>\s*){3,}/giu, "<br><br>")
      .trim();
  }
  return (cleaned ? cleaned + "\n" : "") + "<p>" + FREE_SHIPPING_SENTENCE + "</p>";
}
