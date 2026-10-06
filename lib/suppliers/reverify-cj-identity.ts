import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  persistCjSupplyIntelligence,
  resolveMarketplaceIdentity,
} from "@/lib/intelligence/persist-cj-supply-intelligence";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";

const CURSOR_JOB = "cj-identity-reverify-cursor";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const CONCURRENCY = 5;

const WOMENS_PRODUCT_PATTERNS = [
  /skincare|skin care|serum|moisturizer|face cream|sunscreen|toner|essence|retinol|niacinamide|acne patch|pore strip|facial mask/i,
  /beauty|cosmetic case|cosmetic bag|makeup|lipstick|lip gloss|lip tint|blush|mascara|eyelash|eyeliner|highlighter/i,
  /gua sha|face roller|led beauty mask|cleansing brush|makeup brush|beauty device|nail lamp|nail drill/i,
  /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw/i,
  /women'?s (?:dress|clothing|fashion|bag|shoes|accessory)|womens (?:dress|clothing|fashion|bag|shoes|accessory)|women'?s|womens|sports bra|bralette|shapewear/i,
  /handbag|crossbody bag|tote bag|jewelry|earrings?|necklace|bracelet|hair accessory/i,
  /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor/i,
  /bra organizer|makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|portable garment steamer/i,
];

function isWomensProductTitle(title: unknown): boolean {
  return typeof title === "string" && WOMENS_PRODUCT_PATTERNS.some((pattern) => pattern.test(title));
}

export type CjIdentityReverifyResult = {
  checked: number;
  promoted: number;
  noUniqueBarcodeMatch: number;
  missingEconomics: number;
  errors: Array<{ supplierListingId: string; error: string }>;
  promotedListings: Array<{ supplierListingId: string; bestsellerId: string; method: string }>;
  nextCursor: string | null;
};

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readPersistableBarcode(supplierProductId: string, supplierVariantId: string, persistedBarcode: string | null): Promise<string | null> {
  const supplied = typeof persistedBarcode === "string" ? persistedBarcode.trim().replace(/[^0-9]/g, "") : "";
  if (supplied) return supplied;
  try {
    const variants = await fetchCJProductVariants(supplierProductId, { countryCode: "JP" });
    const variant = variants.find((item) => item.vid === supplierVariantId);
    const barcode = typeof variant?.barcode === "string" ? variant.barcode.trim().replace(/[^0-9]/g, "") : "";
    if (barcode) return barcode;
  } catch (error) {
    console.warn("[cj-identity-reverify] variant barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const variant = await fetchCJVariantByVid(supplierVariantId);
    const barcode = typeof variant?.barcode === "string" ? variant.barcode.trim().replace(/[^0-9]/g, "") : "";
    return barcode || null;
  } catch (error) {
    console.warn("[cj-identity-reverify] queryByVid barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function reverifyCjSupplyIdentities(options: {
  limit?: number;
  deadlineAt?: number;
} = {}): Promise<CjIdentityReverifyResult> {
  const db = createSupabaseAdminClient();
  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;

  const { count: candidateCount, error: countError } = await db
    .from("supplier_listings")
    .select("id", { count: "exact", head: true })
    .eq("supplier", "cj")
    .in("verification_status", ["verified", "unverified", "retryable"])
    .eq("orderable", true)
    .eq("identity_method", "supply_discovered")
    .not("supplier_variant_id", "is", null)
    .not("product_id", "is", null);
  if (countError) throw new Error(`identity reverify candidate count failed: ${countError.message}`);

  const total = candidateCount ?? 0;
  const { data: rows, error } = await db
    .from("supplier_listings")
    .select("id,product_id,title,cost,shipping_cost,inventory,supplier_product_id,supplier_variant_id,identity_method,metadata")
    .eq("supplier", "cj")
    .in("verification_status", ["verified", "unverified", "retryable"])
    .eq("orderable", true)
    .eq("identity_method", "supply_discovered")
    .not("supplier_variant_id", "is", null)
    .not("product_id", "is", null)
    .order("id", { ascending: true });
  if (error) throw new Error(`identity reverify candidate query failed: ${error.message}`);

  const allRows = rows ?? [];
  const womensRows = allRows.filter((row) => isWomensProductTitle(row.title));
  const otherRows = allRows.filter((row) => !isWomensProductTitle(row.title));
  const womensOffset = womensRows.length > limit
    ? (Math.floor(Date.now() / 60_000) * limit) % womensRows.length
    : 0;
  const selectedWomens = womensRows.length > 0
    ? Array.from({ length: Math.min(limit, womensRows.length) }, (_, index) => womensRows[(womensOffset + index) % womensRows.length])
    : [];
  const remaining = Math.max(0, limit - selectedWomens.length);
  const otherOffset = otherRows.length > remaining
    ? (Math.floor(Date.now() / 60_000) * remaining) % otherRows.length
    : 0;
  const selectedOther = remaining > 0 && otherRows.length > 0
    ? Array.from({ length: Math.min(remaining, otherRows.length) }, (_, index) => otherRows[(otherOffset + index) % otherRows.length])
    : [];
  const selectedRows = [...selectedWomens, ...selectedOther];

  const result: CjIdentityReverifyResult = {
    checked: 0,
    promoted: 0,
    noUniqueBarcodeMatch: 0,
    missingEconomics: 0,
    errors: [],
    promotedListings: [],
    nextCursor: total > 0 ? String(selectedRows.at(-1)?.id ?? null) : null,
  };

  const processRow = async (row: NonNullable<typeof rows>[number]) => {
    const supplierListingId = String(row.id);
    try {
      const listingMetadata = record(row.metadata);
      const persistedBarcode = typeof listingMetadata.variant_barcode === "string"
        ? listingMetadata.variant_barcode.trim()
        : null;
      const variantBarcode = await readPersistableBarcode(String(row.supplier_product_id), String(row.supplier_variant_id), persistedBarcode);
      const identity = await resolveMarketplaceIdentity({
        db,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        variantBarcode,
      });
      if (!identity) {
        if (variantBarcode) {
          await db.from("supplier_listings").update({ metadata: { ...listingMetadata, variant_barcode: variantBarcode } }).eq("id", supplierListingId);
        }
        return { kind: "no_match" as const, supplierListingId };
      }

      const canonicalProductId = identity.productId;
      const { data: intelligence } = await db
        .from("product_intelligence")
        .select("image_url,metadata")
        .eq("product_id", canonicalProductId)
        .maybeSingle();
      const metadata = record(intelligence?.metadata);
      const cost = num(row.cost);
      const shippingCost = num(row.shipping_cost);
      const inventory = num(row.inventory);
      const fxRate = num(metadata.fx_rate);
      const sellingPriceJpy = num(metadata.selling_price_jpy);
      const imageUrl = typeof intelligence?.image_url === "string" ? intelligence.image_url : "";
      if (cost === null || shippingCost === null || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) {
        if (variantBarcode) {
          await db.from("supplier_listings").update({ metadata: { ...listingMetadata, variant_barcode: variantBarcode } }).eq("id", supplierListingId);
        }
        return { kind: "missing_economics" as const, supplierListingId };
      }

      await persistCjSupplyIntelligence({
        productId: canonicalProductId,
        title: String(row.title ?? ""),
        imageUrl,
        cost,
        shippingCost,
        supplierListingId,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        inventory,
        query: typeof metadata.query === "string" ? metadata.query : "identity_reverify",
        fxRate,
        sellingPriceJpy,
        variantBarcode,
      }, { identity });

      return { kind: "promoted" as const, supplierListingId, bestsellerId: identity.bestsellerId, method: identity.method };
    } catch (rowError) {
      return { kind: "error" as const, supplierListingId, error: rowError instanceof Error ? rowError.message : String(rowError) };
    }
  };

  let processed = 0;
  for (let offset = 0; offset < selectedRows.length; offset += CONCURRENCY) {
    if (Date.now() >= deadlineAt) break;
    const batch = selectedRows.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(processRow));
    for (const item of results) {
      processed += 1;
      result.checked += 1;
      if (item.kind === "promoted") {
        result.promoted += 1;
        result.promotedListings.push({ supplierListingId: item.supplierListingId, bestsellerId: item.bestsellerId, method: item.method });
      } else if (item.kind === "no_match") {
        result.noUniqueBarcodeMatch += 1;
      } else if (item.kind === "missing_economics") {
        result.missingEconomics += 1;
      } else {
        result.errors.push({ supplierListingId: item.supplierListingId, error: item.error });
      }
    }
  }

  const now = new Date().toISOString();
  await db.from("cron_runs").insert({
    job_name: CURSOR_JOB,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: result.checked,
    failed: result.errors.length,
    metadata: {
      rotationOffset: womensOffset,
      candidateCount: total,
      womensCandidates: womensRows.length,
      womensSelected: selectedWomens.length,
      promoted: result.promoted,
      noUniqueBarcodeMatch: result.noUniqueBarcodeMatch,
      missingEconomics: result.missingEconomics,
      nextCursor: result.nextCursor,
    },
  });
  return result;
}