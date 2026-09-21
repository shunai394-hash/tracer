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
    cacheKey: `demand-intent:v2:${query}`,
    systemInstruction:
      'You classify Google Trends queries for strict ecommerce product-demand discovery. Return ONLY valid JSON in exactly this format: {"is_product_demand":true,"category":"category_name","reason":"short reason"}. Set is_product_demand to true ONLY when the query itself clearly expresses demand for a specific physical product, product type, or consumer-goods category that a shopper could reasonably search with purchase intent. Examples of true: "AirPods Pro", "wireless earbuds", "running shoes", "sunscreen", "プリウス フロアマット". Set is_product_demand to false when the query is primarily a person, place, company, brand alone, vehicle model alone, sports team, athlete, event, race, news, politics, weather, finance, entertainment, anime, movie, TV program, travel destination, or other general topic. A query being related to a product, having products associated with it, or potentially leading to ecommerce sales is NOT sufficient. Do not infer a product that is not explicitly indicated by the query. For example, "トヨタ・プリウス" alone is false; "トヨタ・プリウス フロアマット" is true. For ambiguous queries, return false. Keep category concise and only identify the physical product category explicitly supported by the query. Do not return explanations outside JSON.',
    prompt: JSON.stringify({
      query,
      task: "Strictly classify whether this exact query expresses physical-product purchase demand.",
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
