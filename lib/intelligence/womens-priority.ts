const WOMEN_FOCUSED_PATTERNS = [
  { pattern: /beauty|skincare|skin care|serum|moisturizer|sunscreen|cosmetic|makeup|lipstick|lip gloss|blush|mascara|eyelash|eyeliner|nail art/i, tier: "core" as const },
  { pattern: /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw|hair removal/i, tier: "core" as const },
  { pattern: /women'?s|womens|ladies|female|sports bra|bralette|shapewear|dress|skirt|blouse|leggings|activewear|handbag|crossbody|tote bag/i, tier: "core" as const },
  { pattern: /jewelry|earrings?|necklace|bracelet|hair accessory|anklet|ring jewelry/i, tier: "core" as const },
  { pattern: /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care/i, tier: "core" as const },
  { pattern: /makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|garment steamer|bathroom organization/i, tier: "adjacent" as const },
  { pattern: /wellness|self care|self-care|massage|sleep|posture|aromatherapy|beauty device/i, tier: "adjacent" as const },
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
}): { isWomenFocused: boolean; bonus: number } {
  const haystack = [args.title, args.category, args.query]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();

  const isWomenFocused = WOMEN_FOCUSED_PATTERNS.some((pattern) =>
    pattern.test(haystack),
  );

  // Priority, not a relevance bypass: the candidate must already pass
  // demand relevance. This keeps unrelated women's products out.
  return { isWomenFocused, bonus: isWomenFocused ? 8 : 0 };
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

  const cases = [
    { name: "beauty_is_prioritized", actual: beauty.isWomenFocused && beauty.bonus === 12 && beauty.tier === "core" },
    { name: "automotive_is_not_prioritized", actual: !car.isWomenFocused && car.bonus === 0 },
    { name: "women_signal_survives_query_noise", actual: hair.isWomenFocused && hair.bonus === 12 && hair.tier === "core" },
  ];

  return { ok: cases.every((item) => item.actual), cases };
}
