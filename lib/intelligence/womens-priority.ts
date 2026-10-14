const WOMEN_FOCUSED_PATTERNS = [
  { pattern: /handbag|crossbody bag|tote bag|shoulder bag|backpack|rucksack|purse|satchel|clutch bag|bucket bag|hobo bag|belt bag|waist bag|mini bag|laptop bag|women'?s bag|womens bag|ladies bag|レディースバッグ|ハンドバッグ|ショルダーバッグ|トートバッグ|バックパック|リュック|クラッチバッグ|バケットバッグ|ボディバッグ|ウエストポーチ|ミニバッグ|斜めがけ/i, tier: "core" as const, priority: 1 },
  { pattern: /beauty tool|beauty device|gua sha|face roller|cleansing brush|makeup brush|led beauty mask|nail lamp|nail drill|nail art|manicure|pedicure|美容ツール|美顔器|美顔|美容機器|フェイスローラー|かっさ|洗顔ブラシ|メイクブラシ|ネイル/i, tier: "core" as const, priority: 2 },
  { pattern: /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clips?(?!per)\b|hair claw|hair removal|ヘアケア|ヘアブラシ|頭皮|ヘアオイル|ヘアドライヤー|ヘアアイロン|ヘアクリップ|バンスクリップ|ヘアアクセ|脱毛/i, tier: "core" as const, priority: 3 },
  { pattern: /beauty|skincare|skin care|serum|moisturizer|sunscreen|cosmetic|makeup|lipstick|lip gloss|blush|mascara|eyelash|eyeliner|化粧水|美容液|乳液|日焼け止め|コスメ|メイク|リップ|マスカラ|アイライナー/i, tier: "core" as const, priority: 4 },
  { pattern: /women'?s|womens|ladies|female|sports bra|bralette|shapewear|dress|skirt|blouse|leggings|activewear|レディース|婦人|女性用|女性向け|ワンピース|スカート|ブラウス|レギンス|スポーツブラ/i, tier: "core" as const, priority: 4 },
  { pattern: /jewelry|earrings?|necklace|bracelet|hair accessories?|headbands?|hairbands?|anklet|ring jewelry|ジュエリー|アクセサリー|ピアス|イヤリング|ネックレス|ブレスレット|アンクレット|指輪/i, tier: "core" as const, priority: 4 },
  { pattern: /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care|生理|月経|妊活|妊娠検査|デリケートゾーン/i, tier: "core" as const, priority: 4 },
  { pattern: /makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|garment steamer|bathroom organization|コスメポーチ|化粧ポーチ|アクセサリー収納|衣類スチーマー/i, tier: "adjacent" as const, priority: 5 },
  { pattern: /wellness|self care|self-care|massage|sleep|posture|aromatherapy|ウェルネス|セルフケア|マッサージ|睡眠|姿勢|アロマ/i, tier: "adjacent" as const, priority: 5 },
];

export function womenProductPriority(args: {
  title: string;
  category?: string | null;
  query?: string | null;
}): { isWomenFocused: boolean; bonus: number; tier: "core" | "adjacent" | "none"; categoryPriority: number } {
  const haystack = [args.title, args.category, args.query]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();

  const match = WOMEN_FOCUSED_PATTERNS.find((entry) => entry.pattern.test(haystack));
  const tier = match?.tier ?? "none";
  const categoryPriority = match?.priority ?? (tier === "adjacent" ? 5 : tier === "core" ? 4 : 99);
  const bonus = categoryPriority === 1 ? 20 : categoryPriority === 2 ? 18 : categoryPriority === 3 ? 16 : tier === "core" ? 12 : tier === "adjacent" ? 5 : 0;

  // Category ranking only breaks ties after relevance and hard eligibility gates.
  // It never bypasses identity, inventory, orderability, or positive-margin checks.
  return { isWomenFocused: tier !== "none", bonus, tier, categoryPriority };
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
  const englishBackpack = womenProductPriority({ title: "Retro Cowhide Ladies Small Backpack" });
  const japaneseBeauty = womenProductPriority({ title: "美顔器・美容機器", category: "美容" });
  const hairTies = womenProductPriority({ title: "Rubber Bands 15mm 250 Count Colored Elastic Hair Ties For Braids" });

  const cases = [
    { name: "beauty_is_prioritized", actual: beauty.isWomenFocused && beauty.bonus === 12 && beauty.tier === "core" },
    { name: "automotive_is_not_prioritized", actual: !car.isWomenFocused && car.bonus === 0 && car.categoryPriority === 99 },
    { name: "women_signal_survives_query_noise", actual: hair.isWomenFocused && hair.bonus === 16 && hair.tier === "core" && hair.categoryPriority === 3 },
    { name: "japanese_womens_bag_is_first_priority", actual: japaneseBag.isWomenFocused && japaneseBag.tier === "core" && japaneseBag.categoryPriority === 1 && japaneseBag.bonus === 20 },
    { name: "english_backpack_is_first_priority", actual: englishBackpack.isWomenFocused && englishBackpack.categoryPriority === 1 && englishBackpack.bonus === 20 },
    { name: "japanese_beauty_tool_is_second_priority", actual: japaneseBeauty.isWomenFocused && japaneseBeauty.categoryPriority === 2 && japaneseBeauty.bonus === 18 },
    { name: "hair_ties_are_classified_as_womens_hair_accessories", actual: hairTies.isWomenFocused && hairTies.categoryPriority === 3 && hairTies.bonus === 16 },
    { name: "hair_ranks_after_bags_and_beauty_tools", actual: japaneseBag.bonus > japaneseBeauty.bonus && japaneseBeauty.bonus > hair.bonus },
  ];

  return { ok: cases.every((item) => item.actual), cases };
}
