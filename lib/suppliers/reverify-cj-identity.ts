import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { persistCjSupplyIntelligence, resolveMarketplaceIdentity } from "@/lib/intelligence/persist-cj-supply-intelligence";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";

const CURSOR_JOB = "cj-identity-reverify-cursor";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CONCURRENCY = 5;
const WOMENS_PRODUCT_PATTERNS = [
  /skincare|skin care|serum|moisturizer|moisturiser|face cream|sunscreen|toner|essence|retinol|niacinamide|acne patch|pore strip|facial mask|cleansing/i,
  /beauty|cosmetic case|cosmetic bag|makeup|lipstick|lip gloss|lip tint|blush|mascara|eyelash|eyeliner|highlighter|contour|concealer/i,
  /gua sha|face roller|led beauty mask|cleansing brush|makeup brush|beauty device|nail lamp|nail drill|nail art|manicure|pedicure/i,
  /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw|hair removal/i,
  /women'?s (?:dress|clothing|fashion|bag|shoes|accessory)|womens (?:dress|clothing|fashion|bag|shoes|accessory)|women'?s|womens|ladies|female|sports bra|bralette|shapewear/i,
  /handbag|crossbody bag|tote bag|jewelry|earrings?|necklace|bracelet|hair accessory|anklet|ring jewelry/i,
  /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care/i,
  /bra organizer|makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|portable garment steamer/i,
  /beauty storage|vanity organizer|cosmetic storage|purse organizer|underwear organizer|lingerie/i,
];
function isWomensProductTitle(title: unknown, metadata?: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const searchable = [typeof title === "string" ? title : "", typeof record.category === "string" ? record.category : "", typeof record.query === "string" ? record.query : "", typeof record.tags === "string" ? record.tags : "", Array.isArray(record.tags) ? record.tags.filter((value): value is string => typeof value === "string").join(" ") : ""].join(" ");
  return WOMENS_PRODUCT_PATTERNS.some((pattern) => pattern.test(searchable));
}
export type CjIdentityReverifyResult = { checked: number; promoted: number; supplierVerified: number; noUniqueBarcodeMatch: number; missingEconomics: number; errors: Array<{ supplierListingId: string; error: string }>; promotedListings: Array<{ supplierListingId: string; bestsellerId: string; method: string }>; nextCursor: string | null };
function num(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function readPersistableBarcode(supplierProductId: string, supplierVariantId: string, persistedBarcode: string | null): Promise<string | null> {
  const supplied = typeof persistedBarcode === "string" ? persistedBarcode.trim().replace(/[^0-9]/g, "") : "";
  if (supplied) return supplied;
  try { const variants = await fetchCJProductVariants(supplierProductId, { countryCode: "JP" }); const found = variants.find((item) => item.vid === supplierVariantId); const barcode = typeof found?.barcode === "string" ? found.barcode.trim().replace(/[^0-9]/g, "") : ""; if (barcode) return barcode; } catch (error) { console.warn("[cj-identity-reverify] variant barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) }); }
  try { const variant = await fetchCJVariantByVid(supplierVariantId); const barcode = typeof variant?.barcode === "string" ? variant.barcode.trim().replace(/[^0-9]/g, "") : ""; return barcode || null; } catch (error) { console.warn("[cj-identity-reverify] queryByVid barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) }); return null; }
}
export async function reverifyCjSupplyIdentities(options: { limit?: number; deadlineAt?: number } = {}): Promise<CjIdentityReverifyResult> {
  const db = createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const candidateFilter = db.from("supplier_listings").select("id", { count: "exact", head: true }).eq("supplier", "cj").in("verification_status", ["unverified", "retryable"]).in("identity_method", ["supply_discovered", "none"]).not("supplier_variant_id", "is", null);
  const { count: candidateCount, error: countError } = await candidateFilter;
  if (countError) throw new Error(`identity reverify candidate count failed: ${countError.message}`);
  const total = candidateCount ?? 0;
  const { data: rows, error } = await db.from("supplier_listings").select("id,product_id,title,cost,shipping_cost,inventory,supplier_product_id,supplier_variant_id,identity_method,metadata,gtin,jan,ean,upc,mpn,verification_status,currency").eq("supplier", "cj").in("verification_status", ["unverified", "retryable"]).in("identity_method", ["supply_discovered", "none"]).not("supplier_variant_id", "is", null).order("id", { ascending: true });
  if (error) throw new Error(`identity reverify candidate query failed: ${error.message}`);
  const allRows = rows ?? [];
  const womensRows = allRows.filter((row) => isWomensProductTitle(row.title, row.metadata));
  const otherRows = allRows.filter((row) => !isWomensProductTitle(row.title, row.metadata));
  const priority = (row: typeof allRows[number]) => row.verification_status === "unverified" ? 0 : 1;
  womensRows.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  otherRows.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  const { data: priorRuns } = await db.from("cron_runs").select("metadata").eq("job_name", CURSOR_JOB).eq("status", "succeeded").order("started_at", { ascending: false }).limit(1);
  const priorCursor = typeof record(priorRuns?.[0]?.metadata).nextCursor === "string" ? String(record(priorRuns?.[0]?.metadata).nextCursor) : null;
  const rotateAfterCursor = (items: typeof allRows) => {
    if (!priorCursor || items.length === 0) return items;
    const index = items.findIndex((item) => String(item.id) === priorCursor);
    return index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index + 1)];
  };
  const rotatedWomen = rotateAfterCursor(womensRows);
  const rotatedOther = rotateAfterCursor(otherRows);
  const selectedWomens = rotatedWomen.slice(0, Math.min(limit, rotatedWomen.length));
  const remaining = Math.max(0, limit - selectedWomens.length);
  const selectedOther = remaining > 0 ? rotatedOther.slice(0, Math.min(remaining, rotatedOther.length)) : [];
  const selectedRows = [...selectedWomens, ...selectedOther];
  const result: CjIdentityReverifyResult = { checked: 0, promoted: 0, supplierVerified: 0, noUniqueBarcodeMatch: 0, missingEconomics: 0, errors: [], promotedListings: [], nextCursor: selectedRows.length ? String(selectedRows[selectedRows.length - 1].id) : null };
  const processRow = async (row: NonNullable<typeof rows>[number]) => {
    const supplierListingId = String(row.id);
    try {
      const listingMetadata = record(row.metadata);
      const persistedBarcode = typeof listingMetadata.variant_barcode === "string" ? listingMetadata.variant_barcode.trim() : null;
      const variantBarcode = await readPersistableBarcode(String(row.supplier_product_id), String(row.supplier_variant_id), persistedBarcode);
      const identity = await resolveMarketplaceIdentity({ db, supplierProductId: String(row.supplier_product_id), supplierVariantId: String(row.supplier_variant_id), variantBarcode, supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn } });
      const canonicalProductId = identity?.productId ?? String(row.product_id);
      if (!canonicalProductId) { await db.from("supplier_listings").update({ metadata: { ...listingMetadata, ...(variantBarcode ? { variant_barcode: variantBarcode } : {}), last_identity_reverify_at: new Date().toISOString() } }).eq("id", supplierListingId); return { kind: "no_match" as const, supplierListingId }; }
      const { data: intelligence } = await db.from("product_intelligence").select("image_url,metadata").eq("product_id", canonicalProductId).maybeSingle();
      const metadata = record(intelligence?.metadata);
      const cost = num(row.cost); const shippingCost = num(row.shipping_cost); const inventory = num(row.inventory);
      const storedFxRate = num(metadata.fx_rate);
      const observedFx = storedFxRate === null && String(row.currency ?? "").toUpperCase() === "USD" ? await getObservedUsdToJpyRate() : null;
      const fxRate = storedFxRate ?? observedFx?.rate ?? null;
      const storedSellingPriceJpy = num(metadata.selling_price_jpy);
      const landedCostJpy = cost !== null && shippingCost !== null && fxRate !== null ? (cost + shippingCost) * fxRate : null;
      const sellingPriceJpy = storedSellingPriceJpy ?? (landedCostJpy !== null && Number.isFinite(landedCostJpy) && landedCostJpy >= 0 ? Math.ceil(Math.max(1980, landedCostJpy * 2.5) / 100) * 100 : null);
      const listingImage = [listingMetadata.image_url, listingMetadata.product_image, listingMetadata.productImage, listingMetadata.image].find((value) => typeof value === "string" && /^https?:\/\//i.test(value.trim()));
      const imageUrl = typeof intelligence?.image_url === "string" && /^https?:\/\//i.test(intelligence.image_url.trim()) ? intelligence.image_url.trim() : typeof listingImage === "string" ? listingImage.trim() : "";
      if (cost === null || shippingCost === null || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) { await db.from("supplier_listings").update({ metadata: { ...listingMetadata, ...(variantBarcode ? { variant_barcode: variantBarcode } : {}), last_identity_reverify_at: new Date().toISOString() } }).eq("id", supplierListingId); return { kind: "missing_economics" as const, supplierListingId }; }
      await persistCjSupplyIntelligence({ productId: identity?.productId ?? String(row.product_id), title: String(row.title ?? ""), imageUrl, cost, shippingCost, supplierListingId, supplierProductId: String(row.supplier_product_id), supplierVariantId: String(row.supplier_variant_id), inventory, query: typeof metadata.query === "string" ? metadata.query : "identity_reverify", fxRate, sellingPriceJpy, variantBarcode, supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn } }, { identity });
      return identity ? { kind: "promoted" as const, supplierListingId, bestsellerId: identity.bestsellerId, method: identity.method } : { kind: "supplier_verified" as const, supplierListingId };
    } catch (rowError) { return { kind: "error" as const, supplierListingId, error: rowError instanceof Error ? rowError.message : String(rowError) }; }
  };
  for (let offset = 0; offset < selectedRows.length; offset += CONCURRENCY) { if (Date.now() >= deadlineAt) break; const batch = selectedRows.slice(offset, offset + CONCURRENCY); const results = await Promise.all(batch.map(processRow)); for (const item of results) { result.checked += 1; if (item.kind === "promoted") { result.promoted += 1; result.promotedListings.push({ supplierListingId: item.supplierListingId, bestsellerId: item.bestsellerId, method: item.method }); } else if (item.kind === "supplier_verified") { result.supplierVerified += 1; } else if (item.kind === "no_match") result.noUniqueBarcodeMatch += 1; else if (item.kind === "missing_economics") result.missingEconomics += 1; else result.errors.push({ supplierListingId: item.supplierListingId, error: item.error }); } }
  const now = new Date().toISOString();
  await db.from("cron_runs").insert({ job_name: CURSOR_JOB, status: "succeeded", started_at: now, finished_at: now, processed: result.checked, failed: result.errors.length, metadata: { priorCursor, nextCursor: result.nextCursor, selectionStrategy: "cursor_rotation_womens_priority", candidateCount: total, womensCandidates: womensRows.length, womensSelected: selectedWomens.length, womenUnverifiedCandidates: womensRows.filter((row) => row.verification_status === "unverified").length, promoted: result.promoted, supplierVerified: result.supplierVerified, noUniqueBarcodeMatch: result.noUniqueBarcodeMatch, missingEconomics: result.missingEconomics, identifierFirst: true, orderableNotRequiredForIdentityRecovery: true } });
  return result;
}
