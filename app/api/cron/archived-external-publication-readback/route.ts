import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import {
  getOnlineStorePublicationId,
  isShopifyConfigured,
  shopifyGraphQL,
  toShopifyGid,
} from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

type ArchivedListing = {
  id: string;
  archived_at: string | null;
  archive_reason: string | null;
  base_item_id: string | number | null;
  shopify_product_id: string | null;
  published: boolean | null;
};

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/HTTP[_ ](\d{3})/i)?.[1];
  if (status) return `PROVIDER_HTTP_${status}`;
  if (/not found|does not exist/i.test(message)) return "EXTERNAL_ITEM_NOT_FOUND";
  if (/scope|access denied|forbidden/i.test(message)) return "PROVIDER_PERMISSION_DENIED";
  if (/timeout|aborted|ETIMEDOUT/i.test(message)) return "PROVIDER_TIMEOUT";
  return "PROVIDER_READ_FAILED";
}

/**
 * Read-only audit for archived shop_listings. It checks external state by exact
 * stored BASE item ID / Shopify product ID and never mutates external or DB data.
 * Use limit/offset to scan the complete archived set in bounded batches.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const parsedLimit = Number(url.searchParams.get("limit") || 10);
  const parsedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Number.isFinite(parsedLimit) ? Math.min(15, Math.max(1, Math.floor(parsedLimit))) : 10;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0;

  const db = createSupabaseAdminClient();
  const { data, error, count } = await db
    .from("shop_listings")
    .select("id,archived_at,archive_reason,base_item_id,shopify_product_id,published", { count: "exact" })
    .not("archived_at", "is", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[TRACER ARCHIVED EXTERNAL READBACK] database read failed", {
      offset, limit, code: error.code ?? null,
    });
    return NextResponse.json({ ok: false, error: "archived_listing_read_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as ArchivedListing[];
  let publicationId: string | null = null;
  let shopifyPublicationSetupError: string | null = null;
  if (isShopifyConfigured() && rows.some((row) => String(row.shopify_product_id ?? "").trim())) {
    try {
      publicationId = await getOnlineStorePublicationId();
    } catch (cause) {
      shopifyPublicationSetupError = safeError(cause);
    }
  }

  const results = await Promise.all(rows.map(async (row) => {
    const baseId = String(row.base_item_id ?? "").trim();
    const shopifyId = toShopifyGid("Product", row.shopify_product_id);
    const result: {
      listingId: string;
      archivedAt: string | null;
      archiveReason: string | null;
      base: { itemId: string | null; checked: boolean; visible: boolean | null; stock: number | null; hidden: boolean | null; error: string | null };
      shopify: { productId: string | null; checked: boolean; status: string | null; publishedOnOnlineStore: boolean | null; unpublished: boolean | null; error: string | null };
    } = {
      listingId: String(row.id),
      archivedAt: row.archived_at,
      archiveReason: row.archive_reason,
      base: { itemId: baseId || null, checked: false, visible: null, stock: null, hidden: null, error: null },
      shopify: { productId: shopifyId, checked: false, status: null, publishedOnOnlineStore: null, unpublished: null, error: null },
    };

    if (!baseId) {
      result.base.error = "base_item_id_missing";
    } else if (!/^\d+$/.test(baseId)) {
      result.base.error = "base_item_id_invalid";
    } else if (!isBaseConfigured()) {
      result.base.error = "base_oauth_not_configured";
    } else {
      try {
        const item = await getBaseItemDetail(baseId);
        const rawVisible = item.visible;
        const visible = rawVisible === true || rawVisible === 1 || rawVisible === "1";
        const stockValue = Number(item.stock);
        result.base = {
          itemId: baseId,
          checked: true,
          visible,
          stock: Number.isFinite(stockValue) ? stockValue : null,
          hidden: !visible,
          error: null,
        };
      } catch (cause) {
        result.base.error = safeError(cause);
      }
    }

    if (!String(row.shopify_product_id ?? "").trim()) {
      result.shopify.error = "shopify_product_id_missing";
    } else if (!isShopifyConfigured()) {
      result.shopify.error = "shopify_not_configured";
    } else if (!/^gid:\/\/shopify\/Product\/\d+$/.test(String(shopifyId ?? ""))) {
      result.shopify.error = "shopify_product_id_invalid";
    } else if (!publicationId) {
      result.shopify.error = shopifyPublicationSetupError ?? "shopify_publication_id_unavailable";
    } else {
      try {
        const live = await shopifyGraphQL<{
          product: { id: string; status: string | null; publishedOnPublication: boolean } | null;
        }>(
          `query ArchivedListingPublicationReadback($id: ID!, $publicationId: ID!) {
            product(id: $id) {
              id
              status
              publishedOnPublication(publicationId: $publicationId)
            }
          }`,
          { id: shopifyId, publicationId },
        );
        if (!live.product) {
          result.shopify.error = "EXTERNAL_ITEM_NOT_FOUND";
        } else {
          const published = live.product.publishedOnPublication === true;
          result.shopify = {
            productId: live.product.id,
            checked: true,
            status: live.product.status,
            publishedOnOnlineStore: published,
            unpublished: !published,
            error: null,
          };
        }
      } catch (cause) {
        result.shopify.error = safeError(cause);
      }
    }

    return result;
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    offset,
    limit,
    totalArchivedRows: count ?? null,
    rowsReturned: results.length,
    baseChecked: results.filter((row) => row.base.checked).length,
    baseStillVisible: results.filter((row) => row.base.checked && row.base.visible === true).length,
    baseHidden: results.filter((row) => row.base.checked && row.base.hidden === true).length,
    baseReadErrors: results.filter((row) => row.base.error !== null).length,
    shopifyChecked: results.filter((row) => row.shopify.checked).length,
    shopifyStillPublished: results.filter((row) => row.shopify.checked && row.shopify.publishedOnOnlineStore === true).length,
    shopifyUnpublished: results.filter((row) => row.shopify.checked && row.shopify.unpublished === true).length,
    shopifyReadErrors: results.filter((row) => row.shopify.error !== null).length,
    nextOffset: offset + results.length,
    complete: count !== null && offset + results.length >= count,
    mutationPerformed: false,
  };
  console.info("[TRACER ARCHIVED EXTERNAL READBACK]", summary);
  return NextResponse.json({ ok: summary.baseReadErrors === 0 && summary.shopifyReadErrors === 0, ...summary, results }, {
    status: summary.baseReadErrors > 0 || summary.shopifyReadErrors > 0 ? 207 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
