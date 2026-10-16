import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { calculateCJFreight, fetchCJProductVariants, fetchCJVariantStock } from "@/lib/sources/cj";
import { selectRecoverableVariant } from "@/lib/sources/cj/variant-select";

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

function knownVariantBarcode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const barcode = (metadata as Record<string, unknown>).variant_barcode;
  return typeof barcode === "string" && barcode.trim() ? barcode.trim() : null;
}

export async function repairCjMissingWomenVariants(options: { limit?: number } = {}) {
  const db = createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
  const { data: rows, error } = await db
    .from("supplier_listings")
    .select("id,title,sku,supplier_product_id,supplier_variant_id,verification_status,verification_attempts,next_verification_at,metadata")
    .eq("supplier", "cj")
    .in("verification_status", ["unverified", "retryable"])
    .is("supplier_variant_id", null)
    .not("supplier_product_id", "is", null)
    .or(`next_verification_at.is.null,next_verification_at.lte.${new Date().toISOString()}`)
    .order("next_verification_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) throw new Error(`CJ missing-variant candidate query failed: ${error.message}`);

  const womenRows = (rows ?? []).filter((row) => isWomens(row.title)).slice(0, limit);
  const result = { candidates: womenRows.length, repaired: 0, noVariant: 0, noStock: 0, errors: 0, repairedListings: [] as Array<{ supplierListingId: string; supplierProductId: string; supplierVariantId: string }> };

  for (const row of womenRows) {
    const supplierListingId = String(row.id);
    const supplierProductId = String(row.supplier_product_id);
    const attempts = Math.max(0, Number(row.verification_attempts ?? 0));
    const deferCandidate = async (reason: string, delayMs = Math.min(7 * 86_400_000, 6 * 3_600_000 * 2 ** Math.min(attempts, 5))) => {
      const { error: deferError } = await db.from("supplier_listings").update({
        verification_status: "retryable",
        verification_error: reason,
        verification_attempts: attempts + 1,
        next_verification_at: new Date(Date.now() + delayMs).toISOString(),
      }).eq("id", supplierListingId);
      if (deferError) throw new Error(`candidate backoff write failed: ${deferError.message}`);
    };
    try {
      const variants = await fetchCJProductVariants(supplierProductId, { countryCode: "JP" });
      const variant = selectRecoverableVariant(variants, knownVariantBarcode(row.metadata));
      if (!variant?.vid) {
        result.noVariant += 1;
        await deferCandidate("CJ product has no unambiguous recoverable child variant");
        continue;
      }
      const inventory = await fetchCJVariantStock(variant.vid);
      if (inventory === null || inventory <= 0) {
        result.noStock += 1;
        await deferCandidate("CJ child variant has no confirmed positive stock", 24 * 3_600_000);
        continue;
      }
      const cost = Number(variant.sellPrice);
      if (!Number.isFinite(cost) || cost <= 0) {
        await deferCandidate("CJ child variant has no confirmed positive cost");
        continue;
      }
      const shippingCost = await calculateCJFreight(variant.vid, { endCountryCode: "JP", quantity: 1 });
      if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost < 0) {
        await deferCandidate("CJ Japan freight quote unavailable");
        continue;
      }
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
      const nextMetadata = { ...metadata, variant_recovery: "cj_live_variant_recovery", variant_barcode: variant.barcode ?? metadata.variant_barcode ?? null, variant_sku: variant.sku ?? metadata.variant_sku ?? null, variant_name: variant.nameEn ?? metadata.variant_name ?? null };
      const checkedAt = new Date().toISOString();
      const { error: updateError } = await db.from("supplier_listings").update({
        // Persist CJ's actual child-variant SKU in the indexed supplier SKU
        // field as well as metadata so downstream order mapping can reuse it.
        sku: variant.sku ?? row.sku ?? null,
        supplier_variant_id: variant.vid,
        cj_variant_id: variant.vid,
        cost,
        currency: "USD",
        shipping_cost: shippingCost,
        ship_to: "JP",
        inventory,
        inventory_confirmed: true,
        price_confirmed: true,
        configured: true,
        orderable: true,
        api_available: true,
        // A successful catalog/stock/freight lookup does not prove tracking
        // support. Preserve the existing value until supplier capability is
        // independently confirmed; never manufacture fulfillment evidence.
        verification_status: "retryable",
        verification_error: "Variant, price, stock and Japan freight refreshed; canonical marketplace identity and tracking capability still require verification",
        shipping_status: "verified",
        shipping_checked_at: checkedAt,
        inventory_checked_at: checkedAt,
        last_verified_at: checkedAt,
        metadata: { ...nextMetadata, variant_sku: variant.sku ?? metadata.variant_sku ?? null, variant_currency: "USD", variant_recovered_at: checkedAt },
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
