import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getSuperDeliveryCatalog,
  findSuperDeliveryProductsByJan,
} from "@/lib/sources/superdelivery/client";

const SUPPLIER = "superdelivery";
// ProductSetSearch is fetched once per patrol, so JAN matching is local and
// cheap. Keep the candidate batch bounded, but large enough that the daily
// patrol does not take months to drain the existing JAN backlog.
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 25;

/**
 * SUPER DELIVERY -> TRACER supply bridge.
 * This stage only discovers and persists supplier offers. Publication remains
 * exclusively controlled by the downstream Sales Test Gate.
 *
 * The official ProductSetSearch API does not document a server-side JAN
 * filter, so lookups are deliberately bounded until a scalable catalogue
 * endpoint/pagination contract is provided by SUPER DELIVERY.
 */
export async function discoverSuperDeliverySupply(
  limit = DEFAULT_BATCH_SIZE,
): Promise<{
  configured: boolean;
  considered: number;
  matched: number;
  persisted: number;
  gateCandidates: string[];
  blocked: Array<{ bestsellerId: string; reason: string }>;
}> {
  const db = createSupabaseAdminClient();
  const batch = Math.max(1, Math.min(limit, MAX_BATCH_SIZE));

  const { data: candidates, error } = await db
    .from("marketplace_bestsellers")
    .select("id,product_id,jan,title,pipeline_stage,pipeline_status")
    .not("jan", "is", null)
    .not("product_id", "is", null)
    .in("pipeline_stage", [
      "DISCOVERED",
      "SUPPLIER_INVESTIGATION",
      "VARIANT_VERIFIED",
      "SALES_TEST",
    ])
    .order("fetched_at", { ascending: false })
    .limit(batch);

  if (error) throw new Error(error.message);

  const gateCandidates: string[] = [];
  const catalog = await getSuperDeliveryCatalog();
  const blocked: Array<{ bestsellerId: string; reason: string }> = [];
  let matched = 0;
  let persisted = 0;

  for (const candidate of candidates ?? []) {
    const bestsellerId = String(candidate.id);
    const jan = String(candidate.jan ?? "").trim();

    try {
      const matches = findSuperDeliveryProductsByJan(catalog, jan).filter(
        (item) => item.stock !== null && item.stock > 0,
      );

      if (matches.length === 0) {
        blocked.push({ bestsellerId, reason: "superdelivery_jan_not_found" });
        continue;
      }

      const unique = Array.from(
        new Map(
          matches.map((item) => [
            `${item.sdProductCode ?? ""}:${item.setNo ?? ""}`,
            item,
          ]),
        ).values(),
      );

      if (unique.length !== 1) {
        blocked.push({
          bestsellerId,
          reason: `superdelivery_multiple_sets_for_jan:${unique.length}`,
        });
        continue;
      }

      const item = unique[0];
      const supplierProductId = item.sdProductCode ?? item.makerProductCode;
      const supplierVariantId =
        item.setNo ?? item.sdProductCode ?? item.makerProductCode;

      if (!supplierProductId || !supplierVariantId) {
        blocked.push({
          bestsellerId,
          reason: "superdelivery_variant_unknown",
        });
        continue;
      }

      matched += 1;
      const now = new Date().toISOString();

      const payload = {
        supplier: SUPPLIER,
        external_id: supplierProductId,
        sku: item.makerProductCode,
        title: item.title ?? candidate.title,
        bestseller_id: bestsellerId,
        product_id: String(candidate.product_id),
        jan,
        cost: item.price,
        shipping_cost: null,
        currency: "JPY",
        inventory: item.stock,
        tracking_available: null,
        order_method: "superdelivery",
        api_available: true,
        identity_method: "jan",
        identity_status: "linked",
        identity_confidence: 1,
        configured: true,
        metadata: {
          source: "superdelivery_product_set_search",
          sd_product_code: item.sdProductCode,
          maker_product_code: item.makerProductCode,
          set_no: item.setNo,
          exhibit_state: item.exhibitState,
          image_url: item.imageUrl,
          observed_at: now,
        },
        supplier_product_id: supplierProductId,
        supplier_variant_id: supplierVariantId,
        orderable:
          item.stock !== null &&
          item.stock > 0 &&
          item.exhibitState === 2,
        price_confirmed: item.price !== null,
        inventory_confirmed: item.stock !== null,
        verification_status: "unverified",
        shipping_status: "unknown",
        inventory_checked_at: now,
        fetched_at: now,
      };

      const { data: existing, error: existingError } = await db
        .from("supplier_listings")
        .select("id")
        .eq("supplier", SUPPLIER)
        .eq("bestseller_id", bestsellerId)
        .eq("supplier_product_id", supplierProductId)
        .eq("supplier_variant_id", supplierVariantId)
        .limit(1)
        .maybeSingle();

      if (existingError) throw new Error(existingError.message);

      const result = existing?.id
        ? await db
            .from("supplier_listings")
            .update(payload)
            .eq("id", existing.id)
        : await db.from("supplier_listings").insert(payload);

      if (result.error) throw new Error(result.error.message);

      // Feed the supplier offer into the canonical OI input. The API may not
      // expose price/image for every account; those fields stay null rather
      // than being inferred. OI will therefore remain fail-closed until the
      // missing economic evidence is actually available.
      const { data: existingOffer, error: offerLookupError } = await db
        .from("product_offers")
        .select("id")
        .eq("product_id", String(candidate.product_id))
        .eq("seller_name", "SUPER DELIVERY")
        .eq("offer_url", supplierProductId)
        .limit(1)
        .maybeSingle();
      if (offerLookupError) throw new Error(offerLookupError.message);

      const offerPayload = {
        product_id: String(candidate.product_id),
        seller_name: "SUPER DELIVERY",
        offer_url: supplierProductId,
        image_url: item.imageUrl,
        currency: "JPY",
        price: item.price,
        availability:
          item.stock === null
            ? "unknown"
            : item.stock > 0
              ? "in_stock"
              : "out_of_stock",
        shipping_price: null,
        observed_at: now,
        metadata: {
          provider: "superdelivery",
          supplier_product_id: supplierProductId,
          supplier_variant_id: supplierVariantId,
          jan,
          sd_product_code: item.sdProductCode,
          maker_product_code: item.makerProductCode,
          set_no: item.setNo,
          exhibit_state: item.exhibitState,
          source: "superdelivery_product_set_search",
        },
        currency_confidence: item.price !== null ? "high" : "unknown",
      };

      const offerResult = existingOffer?.id
        ? await db
            .from("product_offers")
            .update(offerPayload)
            .eq("id", existingOffer.id)
        : await db.from("product_offers").insert(offerPayload);
      if (offerResult.error) throw new Error(offerResult.error.message);

      persisted += 1;

      await db
        .from("marketplace_bestsellers")
        .update({
          pipeline_stage: "VARIANT_VERIFIED",
          pipeline_status: "ready",
          pipeline_reason: "superdelivery_supplier_variant_found",
          pipeline_error: null,
          pipeline_updated_at: now,
        })
        .eq("id", bestsellerId);

      gateCandidates.push(bestsellerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blocked.push({
        bestsellerId,
        reason: `superdelivery_lookup_failed:${message}`,
      });

      await db
        .from("marketplace_bestsellers")
        .update({
          pipeline_stage: "SUPPLIER_INVESTIGATION",
          pipeline_status: "blocked",
          pipeline_reason: "superdelivery_lookup_failed",
          pipeline_error: message,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", bestsellerId);
    }
  }

  return {
    configured: true,
    considered: (candidates ?? []).length,
    matched,
    persisted,
    gateCandidates,
    blocked,
  };
}
