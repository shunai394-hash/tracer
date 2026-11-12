import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { httpsUrl, isIntroducibleProduct, type AiLiveProductCard } from "@/lib/ai-live/program";

type ShopListingRow = {
  id: unknown;
  title: unknown;
  description: unknown;
  selling_price: unknown;
  currency: unknown;
  inventory: unknown;
  base_item_id: unknown;
  base_publication_status: unknown;
  image_url: unknown;
  updated_at: unknown;
};

function hasJapaneseText(value: unknown): value is string {
  return typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

/**
 * Sale-ready TRACER listings only. Profit, shipping, and supplier identity
 * stay on the publication gate; this feed does not return those fields.
 * imageUrl is this listing's own https image, or null. It is never borrowed
 * from another color or product.
 */
export async function listSellableAiLiveProducts(
  db: SupabaseClient,
  limit: number,
): Promise<Array<AiLiveProductCard & { updatedAt: string | null; inventory: number }>> {
  const { data, error } = await db
    .from("shop_listings")
    .select(
      "id,title,description,selling_price,currency,inventory,published,orderable,tracking_available,slug,base_item_id,base_publication_status,image_url,archived_at,updated_at",
    )
    .eq("published", true)
    .eq("orderable", true)
    .eq("tracking_available", true)
    .gt("inventory", 0)
    .is("archived_at", null)
    .not("base_item_id", "is", null)
    .eq("base_publication_status", "published")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error("ai_live_product_read_failed");

  return ((data ?? []) as ShopListingRow[])
    .filter((row) =>
      hasJapaneseText(row.title) &&
      row.title.trim().length > 0 &&
      typeof row.selling_price === "number" &&
      Number.isFinite(row.selling_price) &&
      row.selling_price > 0 &&
      typeof row.inventory === "number" &&
      Number.isFinite(row.inventory) &&
      row.inventory > 0,
    )
    .map((row) => {
      const productUrl = row.base_item_id && row.base_publication_status === "published"
        ? `https://tracer.base.ec/items/${encodeURIComponent(String(row.base_item_id))}`
        : null;
      const card: AiLiveProductCard & { updatedAt: string | null; inventory: number } = {
        id: String(row.id),
        title: String(row.title).trim(),
        description: hasJapaneseText(row.description) ? row.description.trim() : null,
        sellingPrice: Number(row.selling_price),
        currency: typeof row.currency === "string" && row.currency.trim() ? row.currency : "JPY",
        inStock: true,
        inventory: Number(row.inventory),
        productUrl: productUrl ?? "",
        imageUrl: httpsUrl(row.image_url),
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      };
      return card;
    })
    .filter((row) => row.productUrl !== null && isIntroducibleProduct(row));
}
