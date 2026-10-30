import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { shopifyGraphQL } from "@/lib/shopify/admin";
import { editBaseItem, fetchBaseItemsPage } from "@/lib/channels/base";
import { freeShippingHtml, freeShippingText, normalizeListingTitle } from "@/lib/commerce/listing-title";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ShopifyNode = {
  id: string;
  title: string;
  descriptionHtml: string;
  media: { nodes: Array<{ id?: string; alt?: string | null }> };
};

function betterTitle(current: string): string | null {
  const next = normalizeListingTitle(current);
  if (!next || next === current.trim()) return null;
  return isJapaneseProductTitle(next) && isPublishableCatalogTitle(next) ? next : null;
}

/**
 * Bounded, resumable sweep of live storefront copy already published on Shopify
 * and BASE: one free-shipping sentence, cleaned titles (shared hygiene rules)
 * and Shopify image alt text that matches the product title. New syncs already
 * produce this copy; the sweep fixes listings that have not been re-synced.
 * POST { channel: "shopify"|"base", apply?: boolean, cursor?, limit? }.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const channel = body.channel;

  if (channel === "shopify") {
    const limit = Math.min(25, Math.max(1, Math.floor(Number(body.limit) || 25)));
    const after = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    const page = await shopifyGraphQL<{ products: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      `query SweepProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "status:active") {
          nodes { id title descriptionHtml media(first: 10) { nodes { ... on MediaImage { id alt } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: limit, after },
    );
    const changes: Array<{ id: string; title?: string; description: boolean; alts: number; error?: string }> = [];
    for (const product of page.products.nodes) {
      const title = betterTitle(product.title);
      const finalTitle = title ?? product.title;
      const descriptionHtml = freeShippingHtml(product.descriptionHtml);
      const alts = product.media.nodes.filter((media) => media.id && (media.alt ?? "") !== finalTitle);
      if (!title && !descriptionHtml && alts.length === 0) continue;
      const change: { id: string; title?: string; description: boolean; alts: number; error?: string } = {
        id: product.id, ...(title ? { title } : {}), description: Boolean(descriptionHtml), alts: alts.length,
      };
      if (apply) {
        try {
          if (title || descriptionHtml) {
            const input: Record<string, unknown> = { id: product.id };
            if (title) input.title = title;
            if (descriptionHtml) input.descriptionHtml = descriptionHtml;
            const updated = await shopifyGraphQL<{ productUpdate: { userErrors: Array<{ message: string }> } }>(
              "mutation SweepProduct($input: ProductUpdateInput!) { productUpdate(product: $input) { userErrors { message } } }",
              { input },
            );
            if (updated.productUpdate.userErrors.length) throw new Error(updated.productUpdate.userErrors.map((e) => e.message).join("; "));
          }
          if (alts.length) {
            // Alt text needs the write_files scope, which this app may not have.
            // A missing scope must not fail the copy fixes made above.
            try {
              const updated = await shopifyGraphQL<{ fileUpdate: { userErrors: Array<{ message: string }> } }>(
                "mutation SweepAlt($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { userErrors { message } } }",
                { files: alts.map((media) => ({ id: media.id, alt: finalTitle.slice(0, 512) })) },
              );
              if (updated.fileUpdate.userErrors.length) throw new Error(updated.fileUpdate.userErrors.map((e) => e.message).join("; "));
            } catch (altError) {
              const message = altError instanceof Error ? altError.message : String(altError);
              if (!/write_files|Access denied/i.test(message)) throw altError;
              change.alts = 0;
            }
          }
        } catch (error) {
          change.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        }
      }
      changes.push(change);
    }
    const failed = changes.filter((change) => change.error).length;
    return NextResponse.json({
      ok: failed === 0, apply, channel, scanned: page.products.nodes.length, changed: changes.length, failed,
      nextCursor: page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null,
      changes: changes.slice(0, 40),
    });
  }

  if (channel === "base") {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(body.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(body.cursor) || 0));
    const items = await fetchBaseItemsPage(limit, offset);
    const changes: Array<{ id: string; title?: string; detail: boolean; error?: string }> = [];
    for (const item of items) {
      const visible = !(item.visible === false || item.visible === 0 || item.visible === "0");
      // Items with BASE-side variations keep per-variation stock; leave them alone.
      if (!visible || (Array.isArray(item.variations) && item.variations.length > 0)) continue;
      const id = String(item.item_id ?? item.id ?? "");
      const currentTitle = String(item.title ?? "");
      const currentDetail = String(item.detail ?? "");
      if (!id || !currentTitle) continue;
      const title = betterTitle(currentTitle);
      const nextDetail = freeShippingText(currentDetail);
      const detailChanged = nextDetail.replace(/\s+/g, "") !== currentDetail.replace(/\s+/g, "");
      if (!title && !detailChanged) continue;
      const change: { id: string; title?: string; detail: boolean; error?: string } = { id, ...(title ? { title } : {}), detail: detailChanged };
      if (apply) {
        try {
          await editBaseItem({
            itemId: id,
            title: title ?? currentTitle,
            detail: detailChanged ? nextDetail : currentDetail,
            price: Math.max(50, Math.round(Number(item.price) || 50)),
            stock: Math.max(0, Math.floor(Number(item.stock) || 0)),
            visible: true,
          });
        } catch (error) {
          change.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        }
      }
      changes.push(change);
    }
    const failed = changes.filter((change) => change.error).length;
    return NextResponse.json({
      ok: failed === 0, apply, channel, scanned: items.length, changed: changes.length, failed,
      nextCursor: items.length === limit ? String(offset + items.length) : null,
      changes: changes.slice(0, 40),
    });
  }

  return NextResponse.json({ ok: false, error: "channel_must_be_shopify_or_base" }, { status: 400 });
}
