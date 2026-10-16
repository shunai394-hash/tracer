/** Vendor TRACER pagination. 100 pages × 100 products. A shorter cap is not a complete store scan. */
export const SHOPIFY_VENDOR_SCAN_MAX_PAGES = 100;

export type ShopifyPageStep =
  | { action: "complete" }
  | { action: "continue"; cursor: string }
  | { action: "incomplete"; reason: "page_cap" | "cursor_stuck" };

/**
 * scanComplete / EXACT is only the "complete" action, which requires Shopify
 * to report there is no next page. Hitting the page cap or a stuck cursor
 * stays incomplete even if some products were read.
 */
export function nextShopifyVendorPage(input: {
  pageIndex: number;
  maxPages: number;
  hasNextPage: boolean;
  endCursor: string | null;
  previousCursor: string | null;
}): ShopifyPageStep {
  if (!input.hasNextPage) return { action: "complete" };
  if (input.pageIndex + 1 >= input.maxPages) return { action: "incomplete", reason: "page_cap" };
  if (!input.endCursor || input.endCursor === input.previousCursor) {
    return { action: "incomplete", reason: "cursor_stuck" };
  }
  return { action: "continue", cursor: input.endCursor };
}
