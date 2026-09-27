import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBaseItem, addBaseItemImage } from "@/lib/channels/base";

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
  const supabase = createSupabaseAdminClient();

  const { data: listings, error } = await supabase
    .from("shop_listings")
    .select(
      "id,title,description,selling_price,image_url,published,base_item_id",
    )
    .eq("published", true)
    .is("base_item_id", null)
    .not("selling_price", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const results: BasePublicationResult["results"] = [];

  for (const listing of listings ?? []) {
    const listingId = String(listing.id);

    if (listing.selling_price === null) {
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_unknown" });
      continue;
    }

    try {
      const base = await createBaseItem({
        title: listing.title,
        detail: listing.description ?? listing.title,
        price: Number(listing.selling_price),
        stock: 1,
        visible: true,
      });

      const baseItemId = base.item_id ?? base.item?.item_id;
      if (baseItemId === undefined || baseItemId === null) {
        throw new Error("BASE item_id was not returned");
      }

      if (listing.image_url) {
        await addBaseItemImage({
          itemId: String(baseItemId),
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
        .update({ base_last_error: message })
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
