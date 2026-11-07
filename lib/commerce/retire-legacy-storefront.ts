import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem } from "@/lib/channels/base";
import { shopifyGraphQL, toShopifyGid, unpublishShopifyProduct } from "@/lib/shopify/admin";
import { classifyLegacyChannelItem, supplierIdentityKey } from "@/lib/commerce/canonical-storefront-owner";

type LegacyListing = {
  id: string;
  supplier_product_id?: string | null;
  supplier_variant_id?: string | null;
  base_item_id?: string | number | null;
  shopify_product_id?: string | null;
  title?: string | null;
  description?: string | null;
  selling_price?: number | string | null;
};

type Db = ReturnType<typeof createSupabaseAdminClient>;

async function hideLegacyItem(channel: "base" | "shopify", listing: LegacyListing): Promise<void> {
  if (channel === "base") {
    const itemId = String(listing.base_item_id ?? "").trim();
    if (!/^\d+$/.test(itemId)) return;
    const price = Math.max(50, Math.round(Number(listing.selling_price) || 50));
    await editBaseItem({
      itemId,
      title: String(listing.title ?? "").trim() || "商品情報確認中",
      detail: String(listing.description ?? listing.title ?? "").trim() || "販売を停止しています。",
      price,
      stock: 0,
      visible: false,
    });
    return;
  }
  const productId = toShopifyGid("Product", listing.shopify_product_id);
  if (!productId) return;
  const updated = await shopifyGraphQL<{
    productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
  }>(
    "mutation TracerRetireDuplicate($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
    { input: { id: productId, status: "DRAFT" } },
  );
  if (updated.productUpdate.userErrors.length || updated.productUpdate.product?.status !== "DRAFT") {
    throw new Error(updated.productUpdate.userErrors.map((error) => error.message).join("; ") || "shopify_duplicate_not_draft");
  }
  await unpublishShopifyProduct(productId);
}

/**
 * Commerce already owns this supplier variant. Archive the legacy row so the
 * old publisher cannot create a second BASE or Shopify product. Hide a legacy
 * item only when its id is not the commerce item.
 */
export async function retireShopListingsOwnedByCommerce(
  listings: LegacyListing[],
  channel: "base" | "shopify",
  supabase: Db,
): Promise<Set<string>> {
  const skip = new Set<string>();
  const supplierVariantIds = [...new Set(listings.map((listing) => String(listing.supplier_variant_id ?? "").trim()).filter(Boolean))];
  if (supplierVariantIds.length === 0) return skip;
  const offers: Array<{ variant_id: string; supplier_product_id: string; supplier_variant_id: string }> = [];
  for (let offset = 0; offset < supplierVariantIds.length; offset += 100) {
    const batch = supplierVariantIds.slice(offset, offset + 100);
    const { data, error } = await supabase.from("supplier_offers")
      .select("variant_id,supplier_product_id,supplier_variant_id")
      .in("supplier_variant_id", batch);
    if (error) throw new Error("commerce_owner_lookup_failed:" + error.message);
    offers.push(...(data ?? []));
  }
  const owners = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const offer of offers) {
    const key = supplierIdentityKey(offer.supplier_product_id, offer.supplier_variant_id);
    if (!key) continue;
    const existing = owners.get(key);
    if (existing && existing !== offer.variant_id) ambiguous.add(key);
    else owners.set(key, offer.variant_id);
  }
  for (const key of ambiguous) owners.delete(key);
  const variantIds = [...new Set(owners.values())];
  const externalByVariant = new Map<string, string | null>();
  for (let offset = 0; offset < variantIds.length; offset += 100) {
    const batch = variantIds.slice(offset, offset + 100);
    const { data, error } = await supabase.from("channel_listings")
      .select("variant_id,external_product_id")
      .eq("channel", channel)
      .in("variant_id", batch);
    if (error) throw new Error("commerce_channel_owner_lookup_failed:" + error.message);
    for (const row of data ?? []) externalByVariant.set(String(row.variant_id), row.external_product_id ? String(row.external_product_id) : null);
  }

  for (const listing of listings) {
    const key = supplierIdentityKey(listing.supplier_product_id, listing.supplier_variant_id);
    const variantId = key ? owners.get(key) : undefined;
    if (!key || !variantId || !externalByVariant.has(variantId)) continue;
    const listingId = String(listing.id);
    const legacyExternalId = channel === "base" ? listing.base_item_id : listing.shopify_product_id;
    const decision = classifyLegacyChannelItem({
      legacyExternalId,
      canonicalExternalId: externalByVariant.get(variantId) ?? null,
    });
    try {
      if (decision === "hide_duplicate") await hideLegacyItem(channel, listing);
      if (decision === "adopt") {
        const legacy = String(legacyExternalId ?? "").trim().split("/").pop() ?? "";
        const { data: adopted, error: adoptError } = await supabase.from("channel_listings")
          .update({
            external_product_id: legacy,
            ...(channel === "base" ? { external_variant_id: legacy } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("channel", channel)
          .eq("variant_id", variantId)
          .is("external_product_id", null)
          .select("id")
          .maybeSingle();
        if (adoptError) throw new Error(adoptError.message);
        if (!adopted) {
          const { data: current, error: currentError } = await supabase.from("channel_listings")
            .select("external_product_id")
            .eq("channel", channel)
            .eq("variant_id", variantId)
            .maybeSingle();
          if (currentError) throw new Error(currentError.message);
          const currentId = String(current?.external_product_id ?? "").split("/").pop() ?? "";
          if (currentId && currentId !== legacy) await hideLegacyItem(channel, listing);
        } else {
          externalByVariant.set(variantId, legacy);
        }
      }
      const { error: archiveError } = await supabase.from("shop_listings").update({
        published: false,
        archived_at: new Date().toISOString(),
        archive_reason: "canonical_commerce_variant",
        updated_at: new Date().toISOString(),
      }).eq("id", listingId).is("archived_at", null);
      if (archiveError) throw new Error(archiveError.message);
      skip.add(listingId);
    } catch (error) {
      // Never let the legacy publisher create another storefront item for this variant.
      skip.add(listingId);
      console.error("[commerce-owner] legacy listing retire failed", {
        listingId,
        channel,
        error: error instanceof Error ? error.message.slice(0, 180) : "retire_failed",
      });
    }
  }
  return skip;
}
