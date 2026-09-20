import { generateCachedStructuredJson } from "@/lib/ai/gemini/cache";

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
      "You convert consumer demand keywords into ecommerce product search keywords. Return ONLY valid JSON in exactly this format: {\"product_queries\":[\"keyword1\",\"keyword2\",\"keyword3\"]}. Generate up to 5 concrete physical-product search keywords suitable for CJdropshipping. Prefer English keywords because the marketplace catalog is primarily English. Do not return explanations.",
    prompt: JSON.stringify({
      demand_query: demandQuery,
      category,
      task: "Generate concrete physical-product search keywords that could be searched in a dropshipping marketplace.",
    }),
  });

  if (!Array.isArray(result.product_queries)) {
    return [];
  }

  return result.product_queries
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 5);
}
