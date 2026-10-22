import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isShopifyConfigured, shopifyGraphQL, toShopifyGid } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type SeoFields = { title: string | null; description: string | null };
type ProductReadback = { id: string; title: string; seo: SeoFields | null };

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim() : "";
}

function seoCopy(titleValue: unknown, descriptionValue: unknown) {
  const title = cleanText(titleValue);
  const description = cleanText(descriptionValue);
  if (!title) throw new Error("canonical_seo_title_missing");
  const seoTitle = title.slice(0, 70).trim();
  // Reuse only facts already in the canonical listing. The title prefix makes
  // short descriptions more specific without inventing product claims.
  const joined = [title, description].filter(Boolean).join("。");
  const seoDescription = (joined || title).slice(0, 320).trim();
  if (!seoTitle || !seoDescription) throw new Error("canonical_seo_metadata_empty");
  return { title: seoTitle, description: seoDescription };
}

/**
 * Backfill only Shopify SEO metadata from TRACER's canonical shop_listings.
 * Product title, description, price, inventory, status and publication are not
 * mutated. Each item is verified with a fresh persisted read before success.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isShopifyConfigured()) {
    return NextResponse.json({ ok: false, error: "SHOPIFY_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  const url = new URL(request.url);
  const limit = Math.min(10, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 10))));
  const afterId = (url.searchParams.get("afterId") || "").trim();
  const db = createSupabaseAdminClient();

  let query = db
    .from("shop_listings")
    .select("id,title,description,shopify_product_id,published,archived_at")
    .is("archived_at", null)
    .eq("published", true)
    .not("shopify_product_id", "is", null);
  if (afterId) query = query.gt("id", afterId);

  const { data: listings, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) {
    return NextResponse.json({ ok: false, error: "TRACER_CANONICAL_LISTINGS_READ_FAILED" }, { status: 502 });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const listing of listings ?? []) {
    const listingId = String(listing.id ?? "");
    const productId = toShopifyGid("Product", String(listing.shopify_product_id ?? ""));
    try {
      if (!listingId || !productId) throw new Error("shopify_product_identity_missing");
      const seo = seoCopy(listing.title, listing.description);
      const mutation = await shopifyGraphQL<{
        productUpdate: {
          product: ProductReadback | null;
          userErrors: Array<{ message: string }>;
        };
      }>(
        `mutation TracerShopifySeoBackfill($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { id title seo { title description } }
            userErrors { message }
          }
        }`,
        { product: { id: productId, seo } },
      );
      const userErrors = mutation.productUpdate.userErrors ?? [];
      if (userErrors.length) throw new Error(userErrors.map((item) => item.message).join("; ").slice(0, 180));
      if (!mutation.productUpdate.product) throw new Error("shopify_product_update_returned_empty");

      const readback = await shopifyGraphQL<{ product: ProductReadback | null }>(
        `query TracerVerifyShopifySeoBackfill($id: ID!) {
          product(id: $id) { id title seo { title description } }
        }`,
        { id: productId },
      );
      const persisted = readback.product;
      const persistedSeo = persisted?.seo;
      const titleMatches = persistedSeo?.title === seo.title ||
        (persistedSeo?.title == null && persisted?.title === seo.title);
      const descriptionMatches = persistedSeo?.description === seo.description;
      if (!persisted || !titleMatches || !descriptionMatches) {
        throw new Error("shopify_seo_readback_mismatch");
      }
      results.push({ listingId, outcome: "updated_and_verified", titleVerified: true, descriptionVerified: true });
    } catch (error) {
      results.push({
        listingId,
        outcome: "failed",
        error: error instanceof Error ? error.message.slice(0, 180) : "SHOPIFY_SEO_BACKFILL_FAILED",
      });
    }
  }

  const updatedAndVerified = results.filter((item) => item.outcome === "updated_and_verified").length;
  const failed = results.length - updatedAndVerified;
  const last = (listings ?? []).at(-1);
  return NextResponse.json({
    ok: failed === 0,
    phase: "shopify_seo_metadata_backfill",
    requested: results.length,
    updatedAndVerified,
    failed,
    nextAfterId: last ? String(last.id) : null,
    complete: (listings ?? []).length < limit,
    results,
  }, { headers: { "Cache-Control": "no-store" } });
}
