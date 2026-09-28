import "server-only";

import { generateStructuredJson } from "@/lib/ai/gemini/client";

export type ProductAiInput = {
  title: string;
  description?: string | null;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  source?: string | null;
  reviews?: Array<{ text: string; rating?: number | null }>;
};

export type ProductAiAnalysis = {
  normalizedTitle: string;
  category: string;
  customerProblems: string[];
  purchaseMotivations: string[];
  adAngles: string[];
  targetCustomer: string;
  demandSignals: string[];
  risks: string[];
  opportunityScore: number;
};

export async function analyzeProductWithAi(input: ProductAiInput): Promise<ProductAiAnalysis> {
  const reviews = (input.reviews ?? []).slice(0, 30);
  return generateStructuredJson<ProductAiAnalysis>({
    systemInstruction:
      "TRACER product intelligence. Analyze demand, customer needs, motivations and advertising angles. Do not invent identifiers, supplier matches, prices or inventory. AI analysis is not product identity proof. Return JSON only.",
    prompt: JSON.stringify({
      task: "Analyze the supplied ecommerce product.",
      product: {
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? null,
        price: input.price ?? null,
        currency: input.currency ?? null,
        source: input.source ?? null,
        reviews,
      },
      outputRules: [
        "customerProblems should focus on concrete problems.",
        "adAngles should be concise and testable.",
        "opportunityScore is an integer from 0 to 100.",
        "Separate evidence from hypotheses.",
      ],
    }),
  });
}
