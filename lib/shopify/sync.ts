import "server-only";

import { isShopifyConfigured } from "@/lib/shopify/admin";
import { syncPublishedListingsToShopify as syncCanonicalShopifyListings } from "@/lib/shopify/sync-published-listings";

export type ShopifySyncResult = {
  configured: boolean;
  attempted: number;
  synced: number;
  failed: Array<{ listingId: string; error: string }>;
};

/**
 * Compatibility facade for older callers.
 * There is intentionally one canonical Shopify listing sync implementation.
 * This prevents the intelligence/admin/sales-test paths from drifting away from
 * the live publication + supply gates used by the dedicated Shopify cron.
 */
export async function syncPublishedListingsToShopify(listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, attempted: 0, synced: 0, failed: [] };

  const result = await syncCanonicalShopifyListings(100, listingIds);
  return {
    configured: result.configured,
    attempted: result.considered,
    synced: result.synced,
    failed: result.errors.map(({ listingId, error }) => ({ listingId, error })),
  };
}
