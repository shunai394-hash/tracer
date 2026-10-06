import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { calculateCJFreight, fetchCJProductVariants, fetchCJVariantStock } from "@/lib/sources/cj";
import { selectUnambiguousVariant, type CJProductVariant } from "@/lib/sources/cj/variant-select";

const WOMENS_PRODUCT_PATTERNS = [
  /skincare|skin care|serum|moisturizer|moisturiser|face cream|sunscreen|toner|essence|retinol|niacinamide|acne patch|pore strip|facial mask|cleansing/i,
  /beauty|cosmetic case|cosmetic bag|makeup|lipstick|lip gloss|lip tint|blush|mascara|eyelash|eyeliner|highlighter|contour|concealer/i,
  /gua sha|face roller|led beauty mask|cleansing brush|makeup brush|beauty device|nail lamp|nail drill|nail art|manicure|pedicure/i,
  /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw|hair removal/i,
  /women'?s|womens|ladies|female|sports bra|bralette|shapewear|dress|handbag|crossbody|tote bag/i,
  /jewelry|earrings?|necklace|bracelet|hair accessory|anklet|ring jewelry/i,
  /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care/i,
  /beauty storage|vanity organizer|cosmetic storage|purse organizer|underwear organizer|lingerie/i,
];

function isWomens(title: unknown): boolean {
  return WOMENS_PRODUCT_PATTERNS.some((pattern) => pattern.test(typeof title === "string" ? title : ""));
}

function selectSafeVariant(variants: CJProductVariant[]): CJProductVariant | null {
  const unambiguous = selectUnambiguousVariant(variants);
  if (unambiguous?.vid) return unambiguous;
  const priced = variants
    .filter((variant) => Boolean(variant.vid) && Number(variant.sellPrice) > 0)
    .sort((a, b) => Number(a.sellPrice) - Number(b.sellPrice));
  return priced.length > 0 ? priced[0] : null;
}

export async function repairCjMissingWomenVariants(options: { limit?: number } = {}) {
  const db = createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
  const { data: rows, error } = await db
    .from("supplier_listings")
    .select("id,title,supplier_product_id,supplier_variant_id,verification_status,metadata")
    .eq("supplier", "cj")
    .eq("verification_status", "unverified")
    .is("supplier_variant_id", null)
    .not("supplier_product_id", "is", null)
    .order("id", { ascending: true })
    .limit(500);
  if (error) throw new Error(`CJ missing-variant candidate query failed: ${error.message}`);

  const womenRows = (rows ?? []).filter((row) => isWomens(row.title)).slice(0, limit);
  const result = { candidates: womenRows.length, repaired: 0, noVariant: 0, noStock: 0, errors: 0, repairedListings: [] as Array<{ supplierListingId: string; supplierProductId: string; supplierVariantId: string }> };

  for (const row of womenRows) {
    const supplierListingId = String(row.id);
    const supplierProductId = String(row.supplier_product_id);
    try {
      const variants = await fetchCJProductVariants(supplierProductId, { countryCode: "JP" });
      const variant = selectSafeVariant(variants);
      if (!variant?.vid) {
        result.noVariant += 1;
        continue;
      }
      const inventory = await fetchCJVariantStock(variant.vid);
      if (inventory === null || inventory <= 0) {
        result.noStock += 1;
        continue;
      }
      const cost = Number(variant.sellPrice);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const shippingCost = await calculateCJFreight(variant.vid, { endCountryCode: "JP", quantity: 1 });
      if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost < 0) continue;
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
      const nextMetadata = { ...metadata, variant_recovery: "cj_live_variant_recovery", variant_barcode: variant.barcode ?? metadata.variant_barcode ?? null, variant_sku: variant.sku ?? metadata.variant_sku ?? null, variant_name: variant.nameEn ?? metadata.variant_name ?? null };
      const { error: updateError } = await db.from("supplier_listings").update({
        supplier_variant_id: variant.vid,
        cost,
        shipping_cost: shippingCost,
        inventory,
        inventory_confirmed: true,
        price_confirmed: true,
        orderable: true,
        tracking_available: true,
        api_available: true,
        verification_status: "retryable",
        verification_error: null,
        metadata: nextMetadata,
        inventory_checked_at: new Date().toISOString(),
      }).eq("id", supplierListingId);
      if (updateError) throw new Error(updateError.message);
      result.repaired += 1;
      result.repairedListings.push({ supplierListingId, supplierProductId, supplierVariantId: variant.vid });
    } catch (error) {
      result.errors += 1;
      console.warn("[cj-missing-variant-repair] candidate failed", { supplierListingId, supplierProductId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
