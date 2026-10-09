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

export async function syncPublishedListingsToShopify(listingIds?: string[], limit = 150): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, attempted: 0, synced: 0, failed: [], listingIds: [] };

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(150, Math.floor(limit)) : 150;
  const result = await syncCanonicalShopifyListings(safeLimit, listingIds);
  return {
    configured: result.configured,
    attempted: result.considered,
    synced: result.synced,
    failed: result.errors.map(({ listingId, error }) => ({ listingId, error })),
    listingIds: result.listingIds,
  };
}
