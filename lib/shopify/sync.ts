import "server-only";

import { isShopifyConfigured } from "@/lib/shopify/admin";
import { syncPublishedListingsToShopify as syncCanonicalShopifyListings } from "@/lib/shopify/sync-published-listings";

export type ShopifySyncResult = {
  configured: boolean;
  attempted: number;
  synced: number;
  failed: Array<{ listingId: string; error: string }>;
  listingIds: string[];
};

export async function syncPublishedListingsToShopify(listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, attempted: 0, synced: 0, failed: [], listingIds: [] };

  const result = await syncCanonicalShopifyListings(100, listingIds);
  return {
    configured: result.configured,
    attempted: result.considered,
    synced: result.synced,
    failed: result.errors.map(({ listingId, error }) => ({ listingId, error })),
    listingIds: result.listingIds,
  };
}
