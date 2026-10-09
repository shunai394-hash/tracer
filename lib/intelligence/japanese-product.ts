const TITLE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bwireless\b/gi, "ワイヤレス"], [/\bportable\b/gi, "ポータブル"], [/\brechargeable\b/gi, "充電式"],
  [/\bwaterproof\b/gi, "防水"], [/\btravel\b/gi, "トラベル"], [/\bmini\b/gi, "ミニ"], [/\blarge\b/gi, "大容量"],
  [/\bsmall\b/gi, "コンパクト"], [/\bsoft\b/gi, "ソフト"], [/\bhard\b/gi, "ハード"], [/\bfoldable\b/gi, "折りたたみ"],
  [/\bportable\s+makeup\s+bag\b/gi, "メイクポーチ"], [/\bmakeup\s+bag\b/gi, "メイクポーチ"],
  [/\bcosmetic\s+bag\b/gi, "コスメポーチ"], [/\btoiletry\s+bag\b/gi, "トラベルポーチ"],
  [/\bhandbag\b/gi, "ハンドバッグ"], [/\bcrossbody\s+bag\b/gi, "ショルダーバッグ"], [/\btote\s+bag\b/gi, "トートバッグ"],
  [/\bbackpack\b/gi, "リュック"], [/\bwallet\b/gi, "財布"], [/\bcard\s+holder\b/gi, "カードケース"],
  [/\bnecklace\b/gi, "ネックレス"], [/\bearrings?\b/gi, "ピアス"], [/\bbracelet\b/gi, "ブレスレット"],
  [/\bring\b/gi, "リング"], [/\bhair\s+clip\b/gi, "ヘアクリップ"], [/\bhair\s+claw\b/gi, "ヘアクリップ"],
  [/\bmakeup\s+brush\b/gi, "メイクブラシ"], [/\bmakeup\b/gi, "メイク"], [/\blipstick\b/gi, "リップスティック"],
  [/\blip\s+gloss\b/gi, "リップグロス"], [/\blip\s+tint\b/gi, "リップティント"], [/\bmascara\b/gi, "マスカラ"],
  [/\beyeliner\b/gi, "アイライナー"], [/\beyeshadow\b/gi, "アイシャドウ"], [/\bblush\b/gi, "チーク"],
  [/\bconcealer\b/gi, "コンシーラー"], [/\bserum\b/gi, "美容液"], [/\bmoisturizer\b/gi, "保湿クリーム"],
  [/\bface\s+cream\b/gi, "フェイスクリーム"], [/\bsunscreen\b/gi, "日焼け止め"], [/\btoner\b/gi, "化粧水"],
  [/\bessence\b/gi, "美容エッセンス"], [/\bcleansing\s+(oil|balm)\b/gi, "クレンジング"],
  [/\bshampoo\b/gi, "シャンプー"], [/\bconditioner\b/gi, "コンディショナー"], [/\bhair\s+dryer\b/gi, "ヘアドライヤー"],
  [/\bhair\s+curler\b/gi, "ヘアカーラー"], [/\bhair\s+straightener\b/gi, "ストレートアイロン"],
  [/\bhair\s+brush\b/gi, "ヘアブラシ"], [/\bscalp\s+massager\b/gi, "頭皮マッサージャー"],
  [/\bskincare\b/gi, "スキンケア"], [/\bbeauty\b/gi, "美容"], [/\bcosmetic(s)?\b/gi, "コスメ"],
  [/\bjewelry\b/gi, "アクセサリー"], [/\baccessor(y|ies)\b/gi, "アクセサリー"], [/\bshoes?\b/gi, "シューズ"],
  [/\bsneakers?\b/gi, "スニーカー"], [/\bdress\b/gi, "ワンピース"], [/\bshirt\b/gi, "シャツ"], [/\btop\b/gi, "トップス"],
  [/\bskirt\b/gi, "スカート"], [/\bpants?\b/gi, "パンツ"], [/\bleggings\b/gi, "レギンス"],
  [/\bbra\b/gi, "ブラ"], [/\bshapewear\b/gi, "補整インナー"], [/\borganizer\b/gi, "収納ケース"],
  [/\bstorage\b/gi, "収納"], [/\bgarment\s+steamer\b/gi, "衣類スチーマー"], [/\bsteamer\b/gi, "スチーマー"],
  [/\bhumidifier\b/gi, "加湿器"], [/\blamp\b/gi, "ライト"], [/\blighting\b/gi, "照明"],
  [/\bphone\s+case\b/gi, "スマホケース"], [/\bphone\s+holder\b/gi, "スマホホルダー"], [/\bstand\b/gi, "スタンド"],
  [/\bpet\b/gi, "ペット"], [/\bcat\b/gi, "猫"], [/\bdog\b/gi, "犬"], [/\btoy\b/gi, "おもちゃ"],
  [/\bwater\s+bottle\b/gi, "ボトル"], [/\bbottle\b/gi, "ボトル"], [/\bcup\b/gi, "カップ"],
  [/\bcase\b/gi, "ケース"], [/\bbag\b/gi, "バッグ"], [/\bstrap\b/gi, "ストラップ"],
  [/\bholder\b/gi, "ホルダー"], [/\bkit\b/gi, "セット"], [/\bset\b/gi, "セット"],
  [/\bblack\b/gi, "ブラック"], [/\bwhite\b/gi, "ホワイト"], [/\bbeige\b/gi, "ベージュ"], [/\bpink\b/gi, "ピンク"],
  [/\bblue\b/gi, "ブルー"], [/\bgreen\b/gi, "グリーン"], [/\bbrown\b/gi, "ブラウン"],
  [/\biphone|smartphone|mobile\b/gi, "スマホ"], [/\btempered\s+(glass|film)|screen\s+protector\b/gi, "保護フィルム"],
  [/\bvase|flower\s+arrangement\b/gi, "フラワーベース"], [/\btoilet\s+brush\b/gi, "トイレブラシ"],
  [/\bbathroom\s+(mat|rug)|floor\s+mat\b/gi, "バスマット"], [/\bshaver|razor\b/gi, "シェーバー"],
  [/\bmakeup\s+sponge|sponge\s+puff\b/gi, "メイクスポンジ"], [/\bair\s+conditioner|air\s+cooler|cooling\s+fan\b/gi, "冷風機"],
  [/\bfan\b/gi, "ファン"], [/\bcat\s+trinket|cat\s+craft\b/gi, "猫モチーフ雑貨"],
  [/\bteapot|coffee\s+table\b/gi, "ティータイム雑貨"], [/\bswimming\s+pool\b/gi, "家庭用プール"],
  [/\bbrush\b/gi, "ブラシ"], [/\bmat\b/gi, "マット"], [/\bflower\b/gi, "フラワー"],
];

const FALLBACK_TITLE_RULES: Array<[RegExp, string]> = [
  [/iphone|smartphone|mobile|phone|tempered|screen protector/i, "スマホ保護アクセサリー"],
  [/vase|flower arrangement/i, "フラワーベース"],
  [/toilet brush/i, "トイレブラシ"],
  [/bathroom|shower|floor mat|foot mat/i, "バスルームマット"],
  [/shaver|razor/i, "電動シェーバー"],
  [/makeup|cosmetic|beauty/i, "美容・メイクアイテム"],
  [/hair|scalp/i, "ヘアケアアイテム"],
  [/bag|wallet|purse/i, "バッグ・収納アイテム"],
  [/jewelry|necklace|earring|bracelet/i, "アクセサリー"],
  [/cat|dog|pet/i, "ペット用品"],
  [/kitchen|cup|bottle|cooking/i, "キッチン用品"],
  [/fan|air conditioner|cooler/i, "冷風・送風アイテム"],
  [/lamp|light|lighting/i, "インテリア照明"],
  [/pool|swimming/i, "レジャー用品"],
];

export function localizeProductTitle(value: unknown, category?: string | null): string | null {
  if (typeof value !== "string") return null;
  let title = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!title) return null;
  for (const [pattern, replacement] of TITLE_REPLACEMENTS) title = title.replace(pattern, replacement);
  title = title.replace(/\s*[-|•]+\s*/g, "・").replace(/\s{2,}/g, " ").trim();
  if (isJapaneseProductTitle(title)) {
    const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
    const latin = (title.match(/[A-Za-z]/g) ?? []).length;
    if (latin <= japanese * 1.5) return title.slice(0, 120);
  }
  const fallback = FALLBACK_TITLE_RULES.find(([pattern]) => pattern.test(value));
  if (fallback) return fallback[1];
  if (typeof category === "string" && category.trim()) return "トレンド・" + category.trim().slice(0, 20) + "アイテム";
  // Verified supplier products may arrive with English-only titles. Never let
  // localization alone block an otherwise fully verified, profitable supply item.
  // Keep the title Japanese so the canonical sales gate remains strict.
  return "暮らしの便利アイテム";
}

const NON_PRODUCT_TITLE_PATTERNS = [
  /商品アイデンティティ/i,
  /選定対象外/,
  /未確定/,
  /必須ゲート/,
  /テスト優先度/,
  /unknown product/i,
  /暮らしの便利アイテム/,
  /^インテリア照明$/,
  /^スマホ保護アクセサリー$/,
  /^キッチン用品$/,
  /^ペット用品$/,
  /^美容・メイクアイテム$/,
  /^ヘアケアアイテム$/,
  /^アクセサリー$/,
  /^バッグ・収納アイテム$/,
  /^トレンド・.+アイテム$/,
];

export function isJapaneseProductTitle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").trim().replace(/\\s+/g, " ");
  if (!title || NON_PRODUCT_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return false;
  const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  return japanese >= 2;
}
