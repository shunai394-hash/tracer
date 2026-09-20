import { generateCachedStructuredJson } from "@/lib/ai/gemini/cache";

export type DemandIntentResponse = {
  is_product_demand?: boolean;
  category?: string | null;
  reason?: string;
};

export async function classifyDemandIntent(
  query: string,
): Promise<DemandIntentResponse> {
  const result = await generateCachedStructuredJson<DemandIntentResponse>({
    cacheKey: `demand-intent:${query}`,
    systemInstruction:
      'You classify Google Trends queries for ecommerce demand discovery. Return ONLY valid JSON in exactly this format: {"is_product_demand":true,"category":"category_name","reason":"short reason"}. Set is_product_demand to true when the query indicates consumer demand that could reasonably lead to a physical product or ecommerce opportunity, even when the query itself is not a product name. Set it to false for news, politics, people, events, sports scores, weather, finance, entertainment, or other non-commerce topics. Do not invent a specific product when the query has no plausible physical-product connection. Keep category concise. Do not return explanations outside JSON.',
    prompt: JSON.stringify({
      query,
      task: "Classify whether this trending query represents physical-product ecommerce demand.",
    }),
  });

  return {
    is_product_demand: result.is_product_demand === true,
    category:
      typeof result.category === "string" && result.category.trim()
        ? result.category.trim()
        : null,
    reason:
      typeof result.reason === "string" && result.reason.trim()
        ? result.reason.trim()
        : "",
  };
}
