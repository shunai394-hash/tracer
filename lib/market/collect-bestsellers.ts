import "server-only";

import type { ParsedBestseller } from "@/lib/market/parse-rankings";

/**
 * Marketplace ranking ingestion was removed by policy.
 * Keep this compatibility entry point so any stale caller gets an empty result
 * instead of contacting Amazon, Rakuten, or Yahoo! Shopping.
 */
export type CollectedMarketplace = {
  marketplace: string;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  items: ParsedBestseller[];
  skipped?: boolean;
  reason?: string;
  enrichment?: {
    attempted: number;
    htmlFetched: number;
    identifierFound: number;
    canonicalVariantCount: number;
    jsonLdNodeCount: number;
    productGroupCount: number;
    groupsWithVariantCount: number;
    variantProductNodeCount: number;
    absoluteTypeIriCount: number;
    variationAsinsFound: number;
    childDetailAttempted: number;
    childDetailFetched: number;
    childBarcodeFound: number;
    brightDataConfigured: boolean;
  };
};

export async function collectMarketplaceBestsellers(options: { sourceIndex?: number } = {}): Promise<{
  fetchedAt: string;
  marketplaces: CollectedMarketplace[];
  itemCount: number;
  sourceIndex: number;
}> {
  return {
    fetchedAt: new Date().toISOString(),
    marketplaces: [],
    itemCount: 0,
    sourceIndex: Math.max(0, options.sourceIndex ?? 0),
  };
}
