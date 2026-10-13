const WOMEN_FOCUSED_PATTERNS = [
  { pattern: /beauty|skincare|skin care|serum|moisturizer|sunscreen|cosmetic|makeup|lipstick|lip gloss|blush|mascara|eyelash|eyeliner|nail art|美容|美顔器|美顔|化粧水|美容液|乳液|日焼け止め|コスメ|メイク|リップ|マスカラ|アイライナー|ネイル/i, tier: "core" as const },
  { pattern: /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw|hair removal|ヘアケア|ヘアブラシ|頭皮|ヘアオイル|ヘアドライヤー|ヘアアイロン|ヘアクリップ|バンスクリップ|ヘアアクセ|脱毛/i, tier: "core" as const },
  { pattern: /women'?s|womens|ladies|female|sports bra|bralette|shapewear|dress|skirt|blouse|leggings|activewear|handbag|crossbody|tote bag|レディース|婦人|女性用|女性向け|バッグ|ハンドバッグ|ショルダーバッグ|トートバッグ|斜めがけ|ワンピース|スカート|ブラウス|レギンス|スポーツブラ/i, tier: "core" as const },
  { pattern: /jewelry|earrings?|necklace|bracelet|hair accessory|anklet|ring jewelry|ジュエリー|アクセサリー|ピアス|イヤリング|ネックレス|ブレスレット|アンクレット|指輪/i, tier: "core" as const },
  { pattern: /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care|生理|月経|妊活|妊娠検査|デリケートゾーン/i, tier: "core" as const },
  { pattern: /makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|garment steamer|bathroom organization|コスメポーチ|化粧ポーチ|アクセサリー収納|衣類スチーマー/i, tier: "adjacent" as const },
  { pattern: /wellness|self care|self-care|massage|sleep|posture|aromatherapy|beauty device|ウェルネス|セルフケア|マッサージ|睡眠|姿勢|アロマ|美容機器/i, tier: "adjacent" as const },
];

export function womenProductPriority(args: {
  title: string;
  category?: string | null;
  query?: string | null;
}): { isWomenFocused: boolean; bonus: number; tier: "core" | "adjacent" | "none" } {
  const haystack = [args.title, args.category, args.query]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();

  const match = WOMEN_FOCUSED_PATTERNS.find((entry) => entry.pattern.test(haystack));
  const tier = match?.tier ?? "none";
  const bonus = tier === "core" ? 12 : tier === "adjacent" ? 5 : 0;

  // Priority, not a relevance bypass: the candidate must already pass
  // demand relevance. This keeps unrelated products out.
  return { isWomenFocused: tier !== "none", bonus, tier };
}

/**
 * Explicit merchandising order requested for the current catalog strategy:
 * handbags first, beauty tools second, hair accessories third. This is a
 * ranking bonus only; all candidates must still pass identity, stock, cost,
 * currency, title-quality, and profit gates.
 */
export function womenMerchandisingPriority(args: {
  title: string;
  category?: string | null;
}): number {
  const text = [args.title, args.category]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();
  if (/handbag|crossbody|tote bag|shoulder bag|women.?s bag|ハンドバッグ|ショルダーバッグ|トートバッグ|斜めがけバッグ/.test(text)) return 3;
  if (/beauty tool|beauty device|facial roller|face roller|gua sha|makeup brush|cosmetic brush|美顔器|美容ツール|メイクブラシ|フェイスローラー/.test(text)) return 2;
  if (/hair clip|hair claw|hairpin|headband|scrunchie|ヘアクリップ|バンスクリップ|ヘアアクセ|シュシュ|ヘアピン|カチューシャ/.test(text)) return 1;
  return 0;
}

export function verifyWomenPriorityInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; actual: boolean }>;
} {
  const beauty = womenProductPriority({
    title: "Niacinamide Face Serum",
    category: "skincare",
    query: "skincare",
  });
  const car = womenProductPriority({
    title: "Toyota Prius Floor Mat",
    category: "automobile",
    query: "toyota prius",
  });
  const hair = womenProductPriority({
    title: "Fashion Hair Clips Women Accessories",
    category: "hair accessories",
    query: "toyota prius",
  });
  const japaneseBag = womenProductPriority({ title: "レディース ショルダーバッグ", category: "バッグ" });
  const japaneseBeauty = womenProductPriority({ title: "美顔器・美容機器", category: "美容" });
  const bagPriority = womenMerchandisingPriority({ title: "レディース ショルダーバッグ" });
  const beautyToolPriority = womenMerchandisingPriority({ title: "美顔器・美容ツール" });
  const hairAccessoryPriority = womenMerchandisingPriority({ title: "フラワー ヘアクリップ" });

  const cases = [
    { name: "beauty_is_prioritized", actual: beauty.isWomenFocused && beauty.bonus === 12 && beauty.tier === "core" },
    { name: "automotive_is_not_prioritized", actual: !car.isWomenFocused && car.bonus === 0 },
    { name: "women_signal_survives_query_noise", actual: hair.isWomenFocused && hair.bonus === 12 && hair.tier === "core" },
    { name: "japanese_womens_bag_is_prioritized", actual: japaneseBag.isWomenFocused && japaneseBag.tier === "core" },
    { name: "japanese_beauty_tool_is_prioritized", actual: japaneseBeauty.isWomenFocused },
    { name: "handbags_rank_first", actual: bagPriority === 3 && bagPriority > beautyToolPriority && bagPriority > hairAccessoryPriority },
    { name: "beauty_tools_rank_second", actual: beautyToolPriority === 2 && beautyToolPriority > hairAccessoryPriority },
    { name: "hair_accessories_rank_third", actual: hairAccessoryPriority === 1 },
  ];

  return { ok: cases.every((item) => item.actual), cases };
}
