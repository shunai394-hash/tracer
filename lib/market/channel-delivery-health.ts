export type ChannelDeliveryHealthInput = {
  selectedCount: number;
  shopify: {
    configured: boolean;
    attempted: number;
    synced: number;
    failedCount: number;
  };
  base: {
    results: Array<{ ok: boolean; baseItemId?: string | null }>;
  };
};

export type ChannelDeliveryHealth = {
  ok: boolean;
  failedCount: number;
  shopifyFailed: number;
  baseFailed: number;
};

/** Counts incomplete delivery per channel without allowing one channel to hide another's failure. */
export function evaluateChannelDeliveryHealth(input: ChannelDeliveryHealthInput): ChannelDeliveryHealth {
  const selectedCount = Math.max(0, Math.floor(input.selectedCount));
  if (selectedCount === 0) return { ok: true, failedCount: 0, shopifyFailed: 0, baseFailed: 0 };

  const shopifyFailed = input.shopify.configured
    ? Math.max(0, input.shopify.failedCount, selectedCount - Math.min(selectedCount, input.shopify.synced))
    : selectedCount;
  const baseSuccesses = input.base.results.filter((item) => item.ok && Boolean(item.baseItemId)).length;
  const baseFailed = Math.max(
    input.base.results.filter((item) => !item.ok || !item.baseItemId).length,
    selectedCount - baseSuccesses,
  );
  const failedCount = shopifyFailed + baseFailed;
  return { ok: failedCount === 0, failedCount, shopifyFailed, baseFailed };
}
