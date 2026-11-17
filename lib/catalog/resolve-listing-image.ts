import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

type ListingImageInput = {
  image_url: string | null;
  supplier_product_id?: string | null;
  supplier_variant_id?: string | null;
};

function validImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Resolve a storefront image by exact supplier product + variant identity.
 * Multi-variant supplier products never fall back to a shared parent image.
 * The variant image must carry both explicit identity and visual verification.
 */
export async function resolveListingImage(
  db: SupabaseClient,
  listing: ListingImageInput,
): Promise<{ imageUrl: string | null; source: "verified_variant" | "single_product" | "blocked"; reason?: string }> {
  const productId = String(listing.supplier_product_id ?? "").trim();
  const variantId = String(listing.supplier_variant_id ?? "").trim();
  if (!productId || !variantId) {
    return { imageUrl: null, source: "blocked", reason: "supplier_identity_or_image_missing" };
  }

  const { data: offer, error: offerError } = await db
    .from("supplier_offers")
    .select("id")
    .eq("supplier_product_id", productId)
    .eq("supplier_variant_id", variantId)
    .limit(1)
    .maybeSingle();
  if (offerError || !offer) {
    return { imageUrl: null, source: "blocked", reason: "exact_supplier_variant_link_missing" };
  }

  const { count, error: countError } = await db
    .from("supplier_offers")
    .select("id", { count: "exact", head: true })
    .eq("supplier_product_id", productId);
  if (countError) return { imageUrl: null, source: "blocked", reason: "supplier_variant_count_unavailable" };
  const isMultiVariant = Number(count ?? 0) > 1;

  const { data: variant, error: variantError } = await db
    .from("commerce_variants")
    .select("attributes")
    .eq("source_variant_key", variantId)
    .maybeSingle();
  if (variantError) return { imageUrl: null, source: "blocked", reason: "variant_image_lookup_failed" };

  const attributes = variant?.attributes && typeof variant.attributes === "object" && !Array.isArray(variant.attributes)
    ? variant.attributes as Record<string, unknown>
    : {};
  const candidate = attributes.variantImageUrl;
  if (
    attributes.variantImageIdentityVerified === true &&
    attributes.colorImageVerified === true &&
    validImageUrl(candidate)
  ) {
    return { imageUrl: candidate, source: "verified_variant" };
  }

  if (isMultiVariant) {
    return { imageUrl: null, source: "blocked", reason: "multi_variant_image_not_visually_verified" };
  }
  return validImageUrl(listing.image_url)
    ? { imageUrl: listing.image_url, source: "single_product" }
    : { imageUrl: null, source: "blocked", reason: "product_image_missing" };
}
