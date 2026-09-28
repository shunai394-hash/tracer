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
      "id,title,description,selling_price,image_url,published,base_item_id,base_publication_status,base_publication_lease_until,inventory,orderable",
    )
    .eq("published", true)
    .not("selling_price", "is", null)
    // Prioritize listings that have not reached BASE yet. Otherwise a cron
    // limit can be consumed entirely by already-published listings and leave
    // new/failed listings waiting indefinitely.
    .order("base_item_id", { ascending: true, nullsFirst: true })
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

      // Claim the external BASE creation slot atomically before calling BASE.
      // Two concurrent cron invocations can both read base_item_id=NULL, but
      // only one can transition this row to "creating".
      if (!baseItemId) {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
        const status = typeof listing.base_publication_status === "string"
          ? listing.base_publication_status
          : null;
        const lease = listing.base_publication_lease_until
          ? new Date(String(listing.base_publication_lease_until))
          : null;

        if (status === "creating" && lease && lease.getTime() > now.getTime()) {
          results.push({ listingId, ok: false, skipped: true, error: "base_publication_in_progress" });
          continue;
        }

        let claimQuery = supabase
          .from("shop_listings")
          .update({
            base_publication_status: "creating",
            base_publication_lease_until: leaseUntil,
          })
          .eq("id", listingId);

        if (status === null) {
          claimQuery = claimQuery.is("base_publication_status", null);
        } else if (status === "creating") {
          claimQuery = claimQuery
            .eq("base_publication_status", "creating")
            .lt("base_publication_lease_until", now.toISOString());
        } else {
          claimQuery = claimQuery.eq("base_publication_status", status);
        }

        const { data: claimed, error: claimError } = await claimQuery.select("id").maybeSingle();
        if (claimError) throw new Error(claimError.message);
        if (!claimed) {
          results.push({ listingId, ok: false, skipped: true, error: "base_publication_claim_lost" });
          continue;
        }
      }

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

        // Persist the external BASE item ID immediately after creation.
        // If image registration or a later DB update fails, a retry must edit
        // the existing BASE item instead of creating a duplicate item.
        const { error: createdItemPersistError } = await supabase
          .from("shop_listings")
          .update({
            base_item_id: baseItemId,
            base_publication_status: "creating",
            base_publication_lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
            base_last_error: null,
          })
          .eq("id", listingId)
          .is("base_item_id", null);
        if (createdItemPersistError) throw new Error(createdItemPersistError.message);

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
          base_publication_status: "published",
          base_publication_lease_until: null,
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
          base_publication_status: "failed",
          base_publication_lease_until: null,
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
