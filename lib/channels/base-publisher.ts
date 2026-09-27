import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBaseItem, editBaseItem, addBaseItemImage, isBaseConfigured } from "@/lib/channels/base";

export type BasePublicationResult = {
  attempted: number;
  published: number;
  skipped: number;
  failed: number;
  results: Array<{
    listingId: string;
    ok: boolean;
    baseItemId?: string | null;
    skipped?: boolean;
    error?: string;
  }>;
};

export async function publishPublishedListingsToBase(
  limit = 10,
): Promise<BasePublicationResult> {
  if (!isBaseConfigured()) {
    return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  }

  const supabase = createSupabaseAdminClient();

  const { data: listings, error } = await supabase
    .from("shop_listings")
    .select(
      "id,title,description,selling_price,image_url,published,base_item_id,inventory,orderable",
    )
    .eq("published", true)
    .not("selling_price", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const results: BasePublicationResult["results"] = [];

  for (const listing of listings ?? []) {
    const listingId = String(listing.id);

    if (listing.selling_price === null) {
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "selling_price_unknown",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_unknown" });
      continue;
    }

    if (!listing.image_url) {
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "image_unknown",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "image_unknown" });
      continue;
    }

    if (listing.inventory === null || listing.orderable !== true) {
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: listing.inventory === null ? "inventory_unknown" : "inventory_zero",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({
        listingId,
        ok: false,
        skipped: true,
        error: listing.inventory === null ? "inventory_unknown" : "inventory_zero",
      });
      continue;
    }

    try {
      let baseItemId: string | null = listing.base_item_id
        ? String(listing.base_item_id)
        : null;

      const stock = Math.max(0, Math.floor(Number(listing.inventory)));

      if (baseItemId) {
        await editBaseItem({
          itemId: baseItemId,
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock,
          visible: true,
        });
      } else {
        const base = await createBaseItem({
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock,
          visible: true,
        });

        const createdBaseItemId = base.item_id ?? base.item?.item_id;
        if (createdBaseItemId === undefined || createdBaseItemId === null) {
          throw new Error("BASE item_id was not returned");
        }
        baseItemId = String(createdBaseItemId);

        await addBaseItemImage({
          itemId: baseItemId,
          imageNo: 1,
          imageUrl: listing.image_url,
        });
      }

      const { error: updateError } = await supabase
        .from("shop_listings")
        .update({
          base_item_id: String(baseItemId),
          base_published_at: new Date().toISOString(),
          base_last_error: null,
          pipeline_stage: "BASE_PUBLISHED",
          pipeline_status: "published",
          pipeline_reason: "base_item_created",
          pipeline_error: null,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId);

      if (updateError) throw new Error(updateError.message);

      results.push({
        listingId,
        ok: true,
        baseItemId: String(baseItemId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase
        .from("shop_listings")
        .update({
          base_last_error: message,
          pipeline_stage: "BASE_PUBLICATION",
          pipeline_status: "failed",
          pipeline_reason: "base_publication_failed",
          pipeline_error: message,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId);

      results.push({ listingId, ok: false, error: message });
    }
  }

  return {
    attempted: results.length,
    published: results.filter((item) => item.ok).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.ok && !item.skipped).length,
    results,
  };
}
