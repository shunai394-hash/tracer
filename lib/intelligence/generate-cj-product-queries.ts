import { generateCachedStructuredJson } from "@/lib/ai/gemini/cache";
import { normalizeIdentityText } from "@/lib/intelligence/identity-confidence";

const UNRELATED_QUERY_TERMS = [
  "hair",
  "wig",
  "watch strap",
  "watch band",
  "bicycle",
  "bike bag",
  "handbag",
  "purse",
  "scrunchie",
];

function looksLikeAutomobileDemand(query: string, category: string | null): boolean {
  const haystack = `${normalizeIdentityText(query)} ${normalizeIdentityText(category)}`;
  return ["prius", "toyota", "honda", "nissan", "mazda", "automobile", "vehicle", "car", "プリウス", "トヨタ"].some(
    (term) => haystack.includes(normalizeIdentityText(term)),
  );
}

function isUnrelatedAccessoryQuery(query: string): boolean {
  const normalized = normalizeIdentityText(query);
  return UNRELATED_QUERY_TERMS.some((term) =>
    normalized.includes(normalizeIdentityText(term)),
  );
}

type ProductQueryResponse = {
  product_queries?: string[];
};

export async function generateCJProductQueries(
  demandQuery: string,
  category: string | null,
): Promise<string[]> {
  const result = await generateCachedStructuredJson<ProductQueryResponse>({
    cacheKey: `cj-queries:${demandQuery}:${category ?? ""}`,
    systemInstruction:
      "You convert one consumer demand keyword into closely related ecommerce product search keywords. Return ONLY valid JSON in exactly this format: {\"product_queries\":[\"keyword1\",\"keyword2\",\"keyword3\"]}. Generate up to 4 English keywords that stay on the same product or product category as the demand query. Do not invent unrelated accessories such as hair clips, watch bands, bicycle bags, or generic fashion items unless the demand query itself is about those products. Prefer the demand keyword and its direct product forms. Do not return explanations.",
    prompt: JSON.stringify({
      demand_query: demandQuery,
      category,
      task: "Generate concrete physical-product search keywords that remain relevant to this demand query.",
    }),
  });

  const generated = Array.isArray(result.product_queries)
    ? result.product_queries
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  const automobileDemand = looksLikeAutomobileDemand(demandQuery, category);

  return [...new Set([demandQuery.trim(), ...generated])]
    .filter(Boolean)
    .filter((query) => !(automobileDemand && isUnrelatedAccessoryQuery(query)))
    .slice(0, 5);
}
