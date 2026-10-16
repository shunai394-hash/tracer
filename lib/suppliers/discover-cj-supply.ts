import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import {
  fetchCJProductVariants,
  fetchCJVariantByVid,
  fetchCJVariantStock,
  getCJProductDetail,
  searchCJProducts,
  calculateCJFreight,
} from "@/lib/sources/cj";
import { isCJQuotaCircuitBlockingError } from "@/lib/sources/cj/client";
import { isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";
import { selectUnambiguousVariant, type CJProductVariant } from "@/lib/sources/cj/variant-select";
import { persistCjSupplyIntelligence } from "@/lib/intelligence/persist-cj-supply-intelligence";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { persistCjInternalSupplyCandidate } from "@/lib/suppliers/persist-cj-internal-supply";

function yenPrice(costUsd: number, shippingUsd: number, fx: number): number {
  const landed = (costUsd + shippingUsd) * fx;
  const withMargin = Math.max(1980, landed * 2.5);
  return Math.ceil(withMargin / 100) * 100;
}

async function resolveCJVariantProductIdentity(
  candidateProductId: string,
  variantId: string,
  productScopedVariant?: CJProductVariant | null,
): Promise<{ variant: CJProductVariant; supplierProductId: string } | null> {
  const scopedProductId = productScopedVariant?.productId?.trim();
  if (productScopedVariant && productScopedVariant.vid === variantId) {
    // A variant returned by the live product-scoped endpoint is already proof
    // that this exact VID belongs to the requested parent. Some CJ responses
    // omit pid on child rows; in that case the parent ID is the product queried.
    const resolvedProductId = scopedProductId || candidateProductId;
    return {
      variant: scopedProductId ? productScopedVariant : { ...productScopedVariant, productId: resolvedProductId },
      supplierProductId: resolvedProductId,
    };
  }

  // Some catalog responses omit pid and fall back to the public catalog ID.
  // Only in that case spend a separate exact-variant lookup to resolve the
  // orderable product ID. This avoids an unnecessary API call for already
  // canonical variant rows.
  const liveVariant = await fetchCJVariantByVid(variantId);
  const liveProductId = liveVariant?.productId?.trim();
  if (!liveVariant || liveVariant.vid !== variantId || !liveProductId) return null;
  if (productScopedVariant && productScopedVariant.vid !== variantId) return null;

  // The exact-variant endpoint is authoritative for the variant's parent
  // product ID. A stale/public catalog ID may differ from that canonical ID;
  // callers must refetch product details for the resolved ID before using them.
  return {
    variant: productScopedVariant
      ? { ...productScopedVariant, productId: liveProductId }
      : liveVariant,
    supplierProductId: liveProductId,
  };
}

function priorityWomenSupplyCategory(title: unknown, metadata: unknown): number {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const searchable = [
    typeof title === "string" ? title : "",
    typeof record.query === "string" ? record.query : "",
    typeof record.category === "string" ? record.category : "",
  ].join(" ").toLowerCase();
  if (/handbag|crossbody bag|shoulder bag|tote bag|mini bag|hobo bag|bucket bag|satchel|clutch bag|purse|wallet|women'?s bag|womens bag|ladies bag|work bag|travel bag/.test(searchable)) return 0;
  if (/makeup|cosmetic|skincare|skin care|gua sha|face roller|beauty tool|nail lamp|facial brush|facial cleansing|pore cleaner|makeup organizer|makeup brush cleaner|beauty device|led beauty|manicure|pedicure/.test(searchable)) return 1;
  if (/hair clip|claw clip|hairpin|hair accessory|hair accessories|heatless curl|hair curler|hair straightener|hair dryer|scalp massager|hair brush/.test(searchable)) return 2;
  return 99;
}

// Commercial priority: women's bags first, then practical beauty tools,
 // then hair accessories. Specific intent queries beat broad category searches.
const CATALOG_QUERIES = [
  // Prioritize women's bags first, then practical beauty tools, then hair accessories.
  "women handbag", "women crossbody bag", "women shoulder bag", "women tote bag",
  "women mini bag", "women work bag", "women hobo bag", "women bucket bag",
  "women satchel bag", "women clutch bag", "women purse", "women travel bag",
  "women cosmetic bag", "travel makeup bag", "makeup pouch women", "everyday handbag women",
  "beauty tools", "facial cleansing brush", "electric face cleansing brush", "gua sha tool",
  "face roller", "makeup brush cleaner", "makeup organizer", "makeup brush set",
  "nail lamp", "nail drill", "beauty device", "skincare tools", "pore cleaner",
  "hair styling tools", "hair clip women", "claw clip women", "flower hair clip",
  "hair accessories women", "heatless curling rod", "hair curler", "hair straightener",
  "scalp massager", "hair brush women", "headband women", "hair pins women",
  "beauty", "makeup", "hair care", "hair tools", "women fashion", "women accessories",
  "jewelry", "period care", "wellness", "self care", "beauty organizer",
  "cosmetic organizer", "jewelry organizer", "closet organizer", "garment steamer",
  "bathroom organization", "home organization", "kitchen", "pet", "phone accessories",
  "fitness", "lighting", "garden", "office", "outdoor", "car accessories",
];
const MAX_CATALOG_PAGES = 50;
// Version the cursor because query order changed; don't reinterpret an old
// index as a different category and silently skip the highest-priority searches.
const CATALOG_CURSOR_JOB = "supply-first-catalog-cursor-v3";

type CatalogCursor = { queryIndex: number; page: number };

function nextCatalogQuery(queryIndex: number, queryCount: number): CatalogCursor {
  return { queryIndex: (queryIndex + 1) % queryCount, page: 1 };
}

async function readCatalogCursor(db: ReturnType<typeof createSupabaseAdminClient>): Promise<CatalogCursor> {
  const { data, error } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", CATALOG_CURSOR_JOB)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`supply-first cursor read failed: ${error.message}`);
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
  const queryIndex = Number(metadata.queryIndex);
  const page = Number(metadata.page);
  return {
    queryIndex: Number.isInteger(queryIndex) && queryIndex >= 0 ? queryIndex : 0,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

async function writeCatalogCursor(
  db: ReturnType<typeof createSupabaseAdminClient>,
  cursor: CatalogCursor & { verified: number; rejected: number; quotaBlocked: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from("cron_runs").insert({
    job_name: CATALOG_CURSOR_JOB,
    // A quota circuit is a blocked run, not a successful catalog pass.
    // Ordinary candidate rejections remain counted without making the whole run fail.
    status: cursor.quotaBlocked ? "failed" : "succeeded",
    started_at: now,
    finished_at: now,
    processed: cursor.verified,
    failed: cursor.rejected,
    metadata: {
      queryIndex: cursor.queryIndex,
      page: cursor.page,
      quotaBlocked: cursor.quotaBlocked,
      reason: cursor.quotaBlocked ? "supplier_quota_cooldown" : null,
    },
  });
  if (error) console.error("[supply-first] catalog cursor write failed", error.message);
}

function selectSupplyFirstVariant(variants: CJProductVariant[]): CJProductVariant | null {
  const priced = variants
    .map((variant) => ({ variant, price: Number(variant.sellPrice) }))
    .filter((item) => item.variant.vid && Number.isFinite(item.price) && item.price > 0)
    .sort((a, b) => a.price - b.price);
  return priced[0]?.variant ?? null;
}

async function markVerification(
  db: ReturnType<typeof createSupabaseAdminClient>,
  id: string,
  patch: { status: "verified" | "unavailable" | "retryable"; shippingStatus?: "verified" | "unavailable" | "retryable" | "unknown"; error?: string; attempts?: number },
): Promise<void> {
  const now = new Date();
  const attempts = Math.max(0, patch.attempts ?? 0);
  // Retryable rows back off (6h, 12h, 24h, ... capped at 7 days) so one
  // persistently failing candidate cannot occupy the head of the queue.
  const delayMs = patch.status === "unavailable" || patch.shippingStatus === "unavailable"
    ? 7 * 86_400_000
    : patch.status === "retryable"
      ? Math.min(7 * 86_400_000, 6 * 3_600_000 * 2 ** Math.min(attempts, 5))
      : 86_400_000;
  const { error } = await db.from("supplier_listings").update({
    verification_status: patch.status,
    shipping_status: patch.shippingStatus ?? undefined,
    verification_error: patch.error ?? null,
    verification_attempts: patch.status === "verified" ? 0 : attempts + 1,
    last_verified_at: patch.status === "verified" ? now.toISOString() : undefined,
    next_verification_at: new Date(now.getTime() + delayMs).toISOString(),
    shipping_checked_at: patch.shippingStatus ? now.toISOString() : undefined,
    inventory_checked_at: now.toISOString(),
  }).eq("id", id);
  // A failed write would leave the row at the head of the due queue and
  // stall traversal, so surface it instead of dropping it.
  if (error) console.error("[supply-first] verification state write failed", { id, error: error.message });
}

async function upsertSupplierListing(
  db: ReturnType<typeof createSupabaseAdminClient>,
  payload: Record<string, unknown>,
  preferredId?: string | null,
): Promise<{ data: { id: string }; error: Error | null }> {
  const supplier = String(payload.supplier ?? "");
  const externalId = String(payload.external_id ?? "");
  const existing = preferredId
    ? await db.from("supplier_listings").select("id").eq("id", preferredId).limit(1)
    : await db.from("supplier_listings").select("id").eq("supplier", supplier).eq("external_id", externalId).order("created_at", { ascending: true }).limit(1);
  if (existing.error) return { data: { id: "" }, error: new Error(existing.error.message) };
  const existingId = existing.data?.[0]?.id ? String(existing.data[0].id) : null;
  const result = existingId
    ? await db.from("supplier_listings").update(payload).eq("id", existingId).select("id").single()
    : await db.from("supplier_listings").insert(payload).select("id").single();
  if (result.error) return { data: { id: "" }, error: new Error(result.error.message) };
  if (!result.data?.id) return { data: { id: "" }, error: new Error("supplier listing upsert returned no id") };
  return { data: { id: String(result.data.id) }, error: null };
}

/**
 * Supply-first path. This deliberately does not claim marketplace identity.
 * The CJ product/variant itself is the source of truth for the sellable item.
 * Every discovered row must have a live variant id, live stock > 0, live
 * Japan freight, a positive cost and a non-empty image. Discovery never publishes.
 */
export async function discoverAndCreateCjSupply(
  limit = 1,
  options?: { deadlineAt?: number },
): Promise<{
  discovered: number;
  published: number;
  verified: number;
  rejected: number;
  candidateCount: number;
  eligibleCount: number;
  deadlineReached: boolean;
  skipped?: boolean;
  retryable?: boolean;
  reason?: string;
  quotaBlocked?: boolean;
  retryAfter?: string;
  items: Array<Record<string, unknown>>;
}> {
  const db = createSupabaseAdminClient();

  // Do not repeatedly query CJ while the persisted provider quota circuit is open.
  // The shared CJ client already fails closed, but checking here prevents each
  // five-minute patrol from re-selecting and rejecting the same seeded candidate.
  const quotaCircuit = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", "cj-api-quota-circuit")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (quotaCircuit.error) {
    throw new Error(`CJ quota circuit lookup failed: ${quotaCircuit.error.message}`);
  }
  const quotaMetadata = quotaCircuit.data?.metadata && typeof quotaCircuit.data.metadata === "object" && !Array.isArray(quotaCircuit.data.metadata)
    ? quotaCircuit.data.metadata as Record<string, unknown>
    : {};
  const quotaBlockedUntil = typeof quotaMetadata.blockedUntil === "string" ? quotaMetadata.blockedUntil : null;
  if (isCJQuotaCircuitActive(quotaMetadata)) {
    return {
      discovered: 0,
      published: 0,
      verified: 0,
      rejected: 0,
      candidateCount: 0,
      eligibleCount: 0,
      // A quota cooldown is an intentional deferral, not a timeout.
      deadlineReached: false,
      skipped: true,
      retryable: true,
      reason: "supplier_quota_cooldown",
      quotaBlocked: true,
      retryAfter: quotaBlockedUntil ?? undefined,
      items: [],
    };
  }

  // Supply discovery is intentionally independent from procurement eligibility.
  // CJ is queried directly below and every candidate is re-verified live for
  // variant, stock, Japan freight and cost. Payment/order-creation gates stay
  // closed for procurement; they must never prevent finding valid supply.
  //
  // CJ exposes live order-status/tracking APIs, so discovered offers can carry
  // tracking capability without enabling automatic purchasing.
  const cjTrackingAvailable = true;

  const fx = await getObservedUsdToJpyRate();
  const fxRate = fx?.rate ?? null;
  if (!fxRate || !Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error("USD/JPY FX rate unavailable");
  }

  const queries = CATALOG_QUERIES;
  const items: Array<Record<string, unknown>> = [];
  let discovered = 0;
  let verified = 0;
  let catalogDiscovered = 0;
  let catalogAttempted = 0;
  let rejected = 0;
  // Once CJ reports an exhausted/unknown quota circuit, stop this invocation.
  // Repeating dozens of searches cannot recover the provider quota and only
  // creates noisy failure records; leave the cursor on the same query to resume later.
  let cjQuotaBlocked = false;

  // Reuse previously discovered CJ IDs first. These rows are only candidates;
  // stock, variant and Japan freight are re-verified live before publication.
  // Do not keep selecting the same existing listing. The first bootstrap
  // run proved the BASE path; subsequent runs must advance through the
  // remaining verified CJ supply candidates.
  // Only variants already sold through the Sales Test Gate are skipped
  // (inventory-refresh maintains those). Variants that merely have a shop
  // listing created outside the gate (e.g. CATALOG_TEST, or a listing blocked
  // for revalidation) still need live verification, offers and
  // product_intelligence, otherwise Opportunity Intelligence can never
  // evaluate them. Verification never publishes.
  const { data: existingListings } = await db
    .from("shop_listings")
    .select("supplier_product_id,supplier_variant_id,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons")
    .not("supplier_variant_id", "is", null);
  const gatePassedListings = (existingListings ?? []).filter((row) => hasPassedSalesTestGate(row));

  // Live catalog discovery (new products) still skips every listed CJ
  // product, so it can never create a second product row for one.
  const existingProducts = new Set(
    (existingListings ?? []).map((row) => String(row.supplier_product_id ?? "")).filter(Boolean),
  );
  const existingVariants = new Set(
    gatePassedListings.map((row) => `${String(row.supplier_product_id ?? "")}:${String(row.supplier_variant_id ?? "")}`),
  );

  // Select only rows that are actually due, in the database. The previous
  // version fetched the top-N rows by inventory (PostgREST may cap this at
  // 1,000) and filtered them in memory, so once those rows had been marked
  // retryable (next check +1 day) runs saw zero eligible candidates while
  // the rest of the table was never read.
  // Ordering by next_verification_at (nulls first) makes that column the
  // traversal cursor: each checked row moves to the back of the queue.
  // Re-process verified CJ supply that has not yet passed the Sales Test Gate.
  // Previously this queue only admitted unverified/retryable rows, which meant
  // the 646 already-verified CJ offers became permanently invisible to the
  // publication path once their initial verification had completed.
  // Gate-passed variants remain excluded by existingVariants; non-gate-passed
  // verified variants are valid publication candidates and are live rechecked.
  const { data: seededRows, error: seededError } = await db
    .from("supplier_listings")
    .select("id,product_id,title,metadata,supplier_product_id,supplier_variant_id,cost,inventory,inventory_confirmed,price_confirmed,verification_status,shipping_status,next_verification_at,verification_attempts,configured,api_available,orderable,tracking_available,ship_to,verification_error,last_verified_at")
    .eq("supplier", "cj")
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .in("verification_status", ["verified", "unverified", "retryable"])
    .or(`next_verification_at.is.null,next_verification_at.lte.${new Date().toISOString()}`)
    .order("next_verification_at", { ascending: true, nullsFirst: true })
    .order("inventory", { ascending: false, nullsFirst: false })
    .limit(500);
  if (seededError) throw new Error(`supply-first candidate query failed: ${seededError.message}`);

  const seenSeedKeys = new Set<string>();
  const seeded = (seededRows ?? [])
    .filter((row) => {
      const key = `${String(row.supplier_product_id)}:${String(row.supplier_variant_id)}`;
      if (existingVariants.has(key) || seenSeedKeys.has(key)) return false;
      seenSeedKeys.add(key);
      // Include every due supplier category. Women-focused categories remain
      // first in the sort order, but category priority must never exclude the
      // rest of the catalog from discovery. Live stock, freight, cost and
      // Japanese-title checks below remain the actual candidate requirements.
      return true;
    })
    .sort((a, b) =>
      priorityWomenSupplyCategory(a.title, a.metadata) - priorityWomenSupplyCategory(b.title, b.metadata) ||
      String(a.next_verification_at ?? "").localeCompare(String(b.next_verification_at ?? "")) ||
      Number(b.inventory ?? 0) - Number(a.inventory ?? 0),
    );

  const deadlineAt = options?.deadlineAt ?? Number.POSITIVE_INFINITY;
  let deadlineReached = false;

  const candidateInputs = seeded.map((row) => ({
    query: "seeded_due",
    id: String(row.supplier_product_id),
    variantId: String(row.supplier_variant_id),
    cost: Number(row.cost),
    inventory: Number(row.inventory),
    inventoryConfirmed: row.inventory_confirmed === true,
    priceConfirmed: row.price_confirmed === true,
    seededTitle: String(row.title ?? ""),
    supplierListingId: String(row.id),
    existingProductId: row.product_id ? String(row.product_id) : null,
    attempts: Number(row.verification_attempts ?? 0),
    verificationStatus: String(row.verification_status ?? ""),
    configured: row.configured === true,
    apiAvailable: row.api_available === true,
    orderable: row.orderable === true,
    trackingAvailable: row.tracking_available === true,
    shipTo: String(row.ship_to ?? "").trim().toUpperCase(),
    supplierProductId: String(row.supplier_product_id ?? ""),
    supplierVariantId: String(row.supplier_variant_id ?? ""),
    verificationError: String(row.verification_error ?? "").trim(),
  }));

  // Refresh a small bounded batch of existing due variants first so stale
  // orderable supply does not get starved by new-catalog discovery. Count
  // attempts separately from successes, then reserve the remaining limit for
  // new catalog candidates.
  const seededVerificationLimit = Math.min(5, Math.max(0, limit));
  let seededChecked = 0;
  for (const seededCandidate of candidateInputs) {
    if (seededChecked >= seededVerificationLimit) break;
    if (Date.now() >= deadlineAt) {
      deadlineReached = true;
      break;
    }
    seededChecked += 1;
    const candidate = {
      id: seededCandidate.id,
      variantId: seededCandidate.variantId,
      title: seededCandidate.seededTitle,
      imageUrl: null,
      price: Number.isFinite(seededCandidate.cost) ? seededCandidate.cost : null,
    };
    const query = seededCandidate.query;
    try {
      // Prefer persisted CJ catalog observations. This avoids spending CJ API
      // requests on product-detail calls for candidates we already observed.
      const { data: cachedProduct } = await db
        .from("demand_cj_products")
        .select("title,price,image_url,inventory")
        .eq("cj_product_id", candidate.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const cachedTitle = String(cachedProduct?.title ?? "").trim();
      const cachedImageUrl = String(cachedProduct?.image_url ?? "").trim();
      const cachedPrice = Number(cachedProduct?.price);
      type ProductDetail = { title: string; imageUrl: string; price: number | null };
      let detail: ProductDetail | null = cachedTitle && cachedImageUrl
        ? { title: cachedTitle, imageUrl: cachedImageUrl, price: Number.isFinite(cachedPrice) ? cachedPrice : null }
        : null;
      if (!detail) {
        const liveDetail = await getCJProductDetail(candidate.id);
        const title = liveDetail?.title?.trim() ?? "";
        const imageUrl = liveDetail?.imageUrl?.trim() ?? "";
        if (title && imageUrl) {
          const parsedPrice = Number(liveDetail?.price);
          detail = { title, imageUrl, price: Number.isFinite(parsedPrice) ? parsedPrice : null };
        }
      }

      // Some CJ product-query responses are empty even though the product is
      // still discoverable through listV2. Do not discard an otherwise
      // orderable seeded variant just because the detail endpoint is missing
      // title/image. Retry the catalog search using the persisted title and
      // require the returned product id to match exactly.
      if (!detail?.imageUrl || !detail.title) {
        const fallbackQuery = seededCandidate.seededTitle.trim();
        if (fallbackQuery) {
          try {
            const fallback = await searchCJProducts(fallbackQuery, { page: 1, size: 20 });
            const matched = fallback.products.find((product) => product.id === candidate.id);
            if (matched?.imageUrl && matched.title) {
              detail = {
                title: matched.title,
                imageUrl: matched.imageUrl,
                price: Number.isFinite(Number(matched.price)) ? Number(matched.price) : null,
              };
            }
          } catch {
            // The original detail failure remains the durable retry reason.
          }
        }
      }

      if (!detail?.imageUrl || !detail.title) {
        rejected++;
        if (seededCandidate.supplierListingId) {
          await markVerification(db, seededCandidate.supplierListingId, {
            status: "retryable",
            error: "product_detail_and_catalog_search_missing",
            attempts: seededCandidate.attempts,
          });
        }
        items.push({
          rejectedStage: "product_detail_and_catalog_search_missing",
          supplierProductId: candidate.id,
        });
        continue;
      }
      // Confirm that this exact variant still belongs to the exact CJ product.
      // A stale persisted variant ID must never be treated as live identity proof.
      const seededVariants = await fetchCJProductVariants(candidate.id, { countryCode: "JP" });
      const productScopedVariant = seededVariants.find((item) => item.vid === candidate.variantId) ?? null;
      const resolvedSeededVariant = await resolveCJVariantProductIdentity(candidate.id, candidate.variantId, productScopedVariant);
      const seededVariant = resolvedSeededVariant?.variant ?? null;
      if (!seededVariant) {
        rejected++;
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, {
          status: "retryable",
          error: "supplier_variant_not_in_live_product",
          attempts: seededCandidate.attempts,
        });
        items.push({ rejectedStage: "supplier_variant_not_in_live_product", supplierProductId: candidate.id, supplierVariantId: candidate.variantId });
        continue;
      }
      const supplierProductId = resolvedSeededVariant!.supplierProductId;
      if (supplierProductId !== candidate.id) {
        // Exact-variant lookup may correct a stale/public product ID. Never
        // keep title/image from the old parent; refetch against the canonical
        // product ID before persisting or publishing this candidate.
        const canonicalDetail = await getCJProductDetail(supplierProductId);
        const canonicalTitle = canonicalDetail?.title?.trim() ?? "";
        const canonicalImageUrl = canonicalDetail?.imageUrl?.trim() ?? "";
        if (!canonicalTitle || !canonicalImageUrl) {
          rejected++;
          if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, {
            status: "retryable",
            error: "canonical_supplier_product_detail_missing",
            attempts: seededCandidate.attempts,
          });
          items.push({ rejectedStage: "canonical_supplier_product_detail_missing", supplierProductId, supplierVariantId: candidate.variantId });
          continue;
        }
        const canonicalPrice = Number(canonicalDetail?.price);
        detail = { title: canonicalTitle, imageUrl: canonicalImageUrl, price: Number.isFinite(canonicalPrice) ? canonicalPrice : null };
      }
      if (!detail) continue;
      // Price must come from the live exact-variant response, not the stale
      // supplier-listing/cache price. Stock and Japan freight are rechecked too.
      const liveCost = Number(seededVariant.sellPrice);
      if (!Number.isFinite(liveCost) || liveCost <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, {
          status: "retryable",
          error: "live_variant_price_unavailable",
          attempts: seededCandidate.attempts,
        });
        items.push({ rejectedStage: "live_variant_price_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId });
        continue;
      }
      const stock = await fetchCJVariantStock(candidate.variantId);

      if (stock === null || stock <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) {
          await markVerification(db, seededCandidate.supplierListingId, {
            status: "retryable",
            error: stock === null ? "live_inventory_unknown" : "live_inventory_zero",
            attempts: seededCandidate.attempts,
          });
        }
        items.push({
          rejectedStage: "live_inventory_unavailable",
          supplierProductId,
          supplierVariantId: candidate.variantId,
          stock,
        });
        continue;
      }
      const freight = await calculateCJFreight(candidate.variantId, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1, zip: "1000001" });
      if (freight === null || freight <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "unavailable", shippingStatus: "unavailable", error: "jp_freight_unavailable", attempts: seededCandidate.attempts });
        items.push({ rejectedStage: "jp_freight_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, freight });
        continue;
      }
      const cost = liveCost;
      const salePrice = yenPrice(cost, freight, fxRate);
      const variantBarcode = typeof seededVariant.barcode === "string" ? seededVariant.barcode : null;
      const displayTitle = localizeProductTitle(detail.title, query);
      if (!displayTitle) {
        rejected++;
        if (seededCandidate.supplierListingId) {
          await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: "japanese_display_title_unavailable", attempts: seededCandidate.attempts });
        }
        items.push({ rejectedStage: "japanese_display_title_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, sourceTitle: detail.title });
        continue;
      }
      const sourceRef = `cj:${supplierProductId}:${candidate.variantId}`;
      // Keep the product this supplier listing already belongs to (a listed
      // product must not be split into a second product row).
      const existingProduct = seededCandidate.existingProductId
        ? { data: { id: seededCandidate.existingProductId }, error: null }
        : await db.from("products").select("id").eq("identity_key", sourceRef).limit(1).maybeSingle();
      if (existingProduct.error) throw new Error(existingProduct.error.message);
      const productInsert = existingProduct.data?.id
        ? await db.from("products").update({ canonical_name: detail.title }).eq("id", existingProduct.data.id).select("id").single()
        : await db.from("products").insert({ canonical_name: detail.title, identity_key: sourceRef }).select("id").single();
      if (productInsert.error) throw new Error(productInsert.error.message);
      const productId = String(productInsert.data.id);
      const refreshedAt = new Date().toISOString();
      const preserveVerifiedOrderPath =
        seededCandidate.verificationStatus === "verified"
        && seededCandidate.configured
        && seededCandidate.apiAvailable
        && seededCandidate.orderable
        && seededCandidate.trackingAvailable
        && seededCandidate.shipTo === "JP"
        && seededCandidate.supplierProductId === supplierProductId
        && seededCandidate.supplierVariantId === candidate.variantId
        && (seededCandidate.verificationError === "" || seededCandidate.verificationError === "CJdropshipping is not configured" || seededCandidate.verificationError === "no_unique_canonical_child_variant_match");
      const supplierInsert = await upsertSupplierListing(db, {
        supplier: "cj", external_id: candidate.variantId, sku: seededVariant.sku ?? null, title: detail.title, product_id: null,
        cost, shipping_cost: freight, currency: "USD", inventory: Math.floor(stock), ship_to: "JP",
        order_method: "cj_api", api_available: preserveVerifiedOrderPath, verification_status: preserveVerifiedOrderPath ? "verified" : "unverified", shipping_status: "verified", identity_method: "supply_discovered",
        identity_status: "supply_discovered", identity_confidence: 0, configured: true,
        supplier_product_id: supplierProductId, supplier_variant_id: candidate.variantId, cj_variant_id: candidate.variantId,
        gtin: normalizeIdentifier("gtin", variantBarcode),
        orderable: preserveVerifiedOrderPath, price_confirmed: true, inventory_confirmed: true, tracking_available: preserveVerifiedOrderPath,
        last_verified_at: preserveVerifiedOrderPath ? refreshedAt : undefined,
        verification_error: preserveVerifiedOrderPath ? null : undefined,
        next_verification_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        fetched_at: refreshedAt, metadata: { source: "cj_supply_first", source_ref: sourceRef, query, fx_rate: fxRate }
      }, seededCandidate.supplierListingId);
      if (supplierInsert.error) throw new Error(supplierInsert.error.message);
      const intelligence = await persistCjSupplyIntelligence({
        productId,
        title: displayTitle,
        imageUrl: detail.imageUrl,
        cost,
        shippingCost: freight,
        supplierListingId: String(supplierInsert.data.id),
        supplierProductId,
        supplierVariantId: candidate.variantId,
        inventory: Math.floor(stock),
        query,
        fxRate,
        sellingPriceJpy: salePrice,
        variantBarcode,
      });
      let internalSupply: { productId: string; variantId: string; sourceRef: string; identityLink: { bestsellerId: string; method: string; rationale: string } | null; auditStatus: "written" | "table_missing" | "write_failed" } | null = null;
      let internalSupplyError: string | null = null;
      try {
        internalSupply = await persistCjInternalSupplyCandidate({
          supplierProductId,
          supplierVariantId: candidate.variantId,
          supplierSku: seededVariant?.sku ?? null,
          title: displayTitle,
          imageUrl: detail.imageUrl,
          barcode: variantBarcode,
          costUsd: cost,
          shippingUsd: freight,
          inventory: Math.floor(stock),
          fxRate,
          sellingPriceJpy: salePrice,
          query,
        });
      } catch (error) {
        internalSupplyError = error instanceof Error ? error.message : String(error);
        console.warn("[supply-first] internal supply ingest failed", {
          supplierProductId: candidate.id,
          supplierVariantId: candidate.variantId,
          error: internalSupplyError,
        });
      }
      discovered++;
      verified++;
      items.push({
        productId,
        supplierListingId: String(supplierInsert.data.id),
        offerId: intelligence.offerId,
        intelligenceId: intelligence.intelligenceId,
        title: displayTitle,
        supplierProductId,
        supplierVariantId: candidate.variantId,
        costUsd: cost,
        freightUsd: freight,
        inventory: Math.floor(stock),
        sellingPriceJpy: salePrice,
        fxRate,
        published: false,
        internalSupplyIngested: Boolean(internalSupply),
        internalSupplyProductId: internalSupply?.productId ?? null,
        internalSupplyVariantId: internalSupply?.variantId ?? null,
        internalSupplySourceRef: internalSupply?.sourceRef ?? null,
        internalSupplyAuditStatus: internalSupply?.auditStatus ?? "not_attempted",
        internalSupplyError,
        identityLink: internalSupply?.identityLink ?? null,
      });
    } catch (error) {
      rejected++;
      const message = error instanceof Error ? error.message : String(error);
      cjQuotaBlocked = isCJQuotaCircuitBlockingError(error);
      items.push({
        rejectedStage: cjQuotaBlocked ? "supplier_quota_cooldown" : "error",
        supplierProductId: candidate.id,
        supplierVariantId: candidate.variantId,
        error: message,
      });
      if (seededCandidate.supplierListingId && !cjQuotaBlocked) {
        await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: message.slice(0, 500), attempts: seededCandidate.attempts });
      }
      console.warn("[supply-first] seeded candidate rejected", { productId: candidate.id, error: message, quotaBlocked: cjQuotaBlocked });
      if (cjQuotaBlocked) break;
    }
  }

  const catalogDiscoveryLimit = Math.max(0, limit - seededChecked);

  // Seeded verification is only one source of candidates. If all seeded
  // variants fail live Japan-freight verification, continue into the live CJ
  // catalog instead of stopping with zero new products.
  // Persisted catalog cursor. The previous loop always read page 1 of the
  // same five queries, so every run re-inspected (and re-rejected) the same
  // ~100 products and discovery never advanced.
  const cursor = await readCatalogCursor(db);
  let queryIndex = cursor.queryIndex % queries.length;
  let page = cursor.page;
  let pagesScanned = 0;
  // Advance the persisted cursor after a small number of search pages. Scanning
  // two pages for every configured query made a no-new-products pass exceed the
  // route deadline while repeatedly seeing already-ingested CJ IDs.
  const MAX_CATALOG_SEARCH_PAGES_PER_RUN = 5;
  const seenSearchProducts = new Set<string>();
  while (!cjQuotaBlocked && catalogDiscovered < catalogDiscoveryLimit && pagesScanned < MAX_CATALOG_SEARCH_PAGES_PER_RUN) {
    if (Date.now() >= deadlineAt) {
      deadlineReached = true;
      break;
    }
    const query = queries[queryIndex];
    pagesScanned++;

    let search;
    try {
      search = await searchCJProducts(query, { page, size: 20 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cjQuotaBlocked = isCJQuotaCircuitBlockingError(error);
      items.push({
        rejectedStage: cjQuotaBlocked ? "supplier_quota_cooldown" : "catalog_search_failed",
        query,
        page,
        error: message,
      });
      if (cjQuotaBlocked) break;
      ({ queryIndex, page } = nextCatalogQuery(queryIndex, queries.length));
      continue;
    }
    const pageExhausted = search.products.length === 0 || page >= Math.min(search.totalPages, MAX_CATALOG_PAGES);
    const pageQuery = query;
    const pageNumber = page;
    let pageCompleted = true;
    for (const candidate of search.products.map((x) => ({ ...x, variantId: null as string | null }))) {
      if (catalogAttempted >= catalogDiscoveryLimit || Date.now() >= deadlineAt) {
        if (Date.now() >= deadlineAt) deadlineReached = true;
        pageCompleted = false;
        break;
      }
      if (seenSearchProducts.has(candidate.id)) continue;
      seenSearchProducts.add(candidate.id);
      if (existingProducts.has(candidate.id)) continue;
      catalogAttempted += 1;
      const reject = (stage: string, extra?: Record<string, unknown>) => {
        rejected++;
        items.push({ rejectedStage: stage, supplierProductId: candidate.id, query: pageQuery, page: pageNumber, ...extra });
      };
      if (!candidate.imageUrl || !candidate.title) {
        reject("catalog_image_or_title_missing");
        continue;
      }

      try {
        // listV2 already carries title/image/price; a separate detail call
        // only spent one rate-limited CJ request per candidate.
        let detail: { title: string; imageUrl: string; price: number | null } = {
          title: candidate.title,
          imageUrl: candidate.imageUrl,
          price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
        };

        const variants = await fetchCJProductVariants(candidate.id);
        // In supply-first the CJ variant itself is the sellable item, so a
        // multi-variant product is not ambiguous: pick one concrete variant
        // (cheapest priced) and name it explicitly in the listing title.
        const selectedVariant =
          (candidate.variantId
            ? variants.find((x) => x.vid === candidate.variantId)
            : null) ??
          selectUnambiguousVariant(variants) ??
          selectSupplyFirstVariant(variants);
        if (!selectedVariant?.vid) {
          reject("variant_unavailable", { variantCount: variants.length });
          continue;
        }
        const resolvedVariant = await resolveCJVariantProductIdentity(candidate.id, selectedVariant.vid, selectedVariant);
        if (!resolvedVariant) {
          reject("canonical_supplier_product_id_unresolved", { candidateProductId: candidate.id, supplierVariantId: selectedVariant.vid });
          continue;
        }
        const variant = resolvedVariant.variant;
        const supplierProductId = resolvedVariant.supplierProductId;
        if (supplierProductId !== candidate.id) {
          const canonicalDetail = await getCJProductDetail(supplierProductId);
          const canonicalTitle = canonicalDetail?.title?.trim() ?? "";
          const canonicalImageUrl = canonicalDetail?.imageUrl?.trim() ?? "";
          if (!canonicalTitle || !canonicalImageUrl) {
            reject("canonical_supplier_product_detail_missing", { supplierProductId, supplierVariantId: variant.vid });
            continue;
          }
          const canonicalPrice = Number(canonicalDetail?.price);
          detail = { title: canonicalTitle, imageUrl: canonicalImageUrl, price: Number.isFinite(canonicalPrice) ? canonicalPrice : null };
        }
        if (existingProducts.has(supplierProductId)) {
          reject("supplier_product_already_exists", { supplierProductId, supplierVariantId: variant.vid });
          continue;
        }

        const stock = await fetchCJVariantStock(variant.vid);
        if (stock === null || stock <= 0) {
          reject(stock === null ? "live_inventory_unknown" : "live_inventory_zero", { supplierVariantId: variant.vid, stock });
          continue;
        }

        const freight = await calculateCJFreight(variant.vid, {
          startCountryCode: "CN",
          endCountryCode: "JP",
          quantity: 1,
          zip: "1000001",
        });
        if (freight === null || freight <= 0) {
          reject("jp_freight_unavailable", { supplierVariantId: variant.vid, freight });
          continue;
        }

        const cost = Number(variant.sellPrice ?? detail.price);
        if (!Number.isFinite(cost) || cost <= 0) {
          reject("cost_unavailable", { supplierVariantId: variant.vid });
          continue;
        }
        if (variants.length > 1 && variant.nameEn) {
          detail.title = `${detail.title} (${variant.nameEn})`;
        }

        const displayTitle = localizeProductTitle(detail.title, query);
        if (!displayTitle) {
          reject("japanese_display_title_unavailable", { sourceTitle: detail.title, supplierVariantId: variant.vid });
          continue;
        }

        const salePrice = yenPrice(cost, freight, fxRate);
        const variantBarcode = typeof variant.barcode === "string" ? variant.barcode : null;
        const sourceRef = `cj:${supplierProductId}:${variant.vid}`;
        const identityKey = sourceRef;
        const now = new Date().toISOString();

        // Do not depend on a live UNIQUE constraint for this supply-first
        // path. Some production databases are behind the migration that added
        // products.identity_key, and PostgREST upsert then fails with
        // "no unique or exclusion constraint matching the ON CONFLICT
        // specification". A lookup + insert/update keeps discovery moving.
        const existingProduct = await db
          .from("products")
          .select("id")
          .eq("identity_key", identityKey)
          .limit(1)
          .maybeSingle();
        if (existingProduct.error) throw new Error(existingProduct.error.message);

        const productInsert = existingProduct.data?.id
          ? await db
              .from("products")
              .update({ canonical_name: detail.title })
              .eq("id", existingProduct.data.id)
              .select("id")
              .single()
          : await db
              .from("products")
              .insert({
                canonical_name: detail.title,
                identity_key: identityKey,
              })
              .select("id")
              .single();

        if (productInsert.error) throw new Error(productInsert.error.message);
        const productId = String(productInsert.data.id);

        const supplierInsert = await upsertSupplierListing(db, 
            {
              supplier: "cj",
              external_id: variant.vid,
              sku: variant.sku,
              title: detail.title,
              // Discovery is not canonical identity. Keep unresolved supply detached until a unique exact-variant match exists.
              product_id: null,
              cost,
              shipping_cost: freight,
              currency: "USD",
              inventory: Math.floor(stock),
              ship_to: "JP",
              order_method: "cj_api",
              api_available: false,
              verification_status: "unverified",
              identity_method: "supply_discovered",
              identity_status: "supply_discovered",
              identity_confidence: 0,
              configured: true,
              supplier_product_id: supplierProductId,
              supplier_variant_id: variant.vid,
              cj_variant_id: variant.vid,
              gtin: normalizeIdentifier("gtin", variantBarcode),
              orderable: false,
              price_confirmed: true,
              inventory_confirmed: true,
              tracking_available: false,
              next_verification_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              fetched_at: now,
              metadata: {
                source: "cj_supply_first",
                source_ref: sourceRef,
                query,
                fx_rate: fxRate,
                freight_usd: freight,
                image_url: detail.imageUrl,
                variant_title: variant.nameEn,
              },
            });

        if (supplierInsert.error) throw new Error(supplierInsert.error.message);
        const supplierListingId = String(supplierInsert.data.id);

        const intelligence = await persistCjSupplyIntelligence({
          productId,
          title: displayTitle,
          imageUrl: detail.imageUrl,
          cost,
          shippingCost: freight,
          supplierListingId,
          supplierProductId,
          supplierVariantId: variant.vid,
          inventory: Math.floor(stock),
          query,
          fxRate,
          sellingPriceJpy: salePrice,
          variantBarcode,
        });
        let internalSupply: { productId: string; variantId: string; sourceRef: string; identityLink: { bestsellerId: string; method: string; rationale: string } | null; auditStatus: "written" | "table_missing" | "write_failed" } | null = null;
        let internalSupplyError: string | null = null;
        try {
          internalSupply = await persistCjInternalSupplyCandidate({
            supplierProductId,
            supplierVariantId: variant.vid,
            supplierSku: variant.sku ?? null,
            title: displayTitle,
            imageUrl: detail.imageUrl,
            barcode: variantBarcode,
            costUsd: cost,
            shippingUsd: freight,
            inventory: Math.floor(stock),
            fxRate,
            sellingPriceJpy: salePrice,
            query,
          });
        } catch (error) {
          internalSupplyError = error instanceof Error ? error.message : String(error);
          console.warn("[supply-first] internal supply ingest failed", {
            supplierProductId: candidate.id,
            supplierVariantId: variant.vid,
            error: internalSupplyError,
          });
        }
        existingProducts.add(supplierProductId);
        discovered++;
        verified++;
        catalogDiscovered++;
        items.push({
          productId,
          supplierListingId,
          offerId: intelligence.offerId,
          intelligenceId: intelligence.intelligenceId,
          title: displayTitle,
          supplierProductId,
          supplierVariantId: variant.vid,
          costUsd: cost,
          freightUsd: freight,
          inventory: Math.floor(stock),
          sellingPriceJpy: salePrice,
          fxRate,
          published: false,
          internalSupplyIngested: Boolean(internalSupply),
          internalSupplyProductId: internalSupply?.productId ?? null,
          internalSupplyVariantId: internalSupply?.variantId ?? null,
          internalSupplySourceRef: internalSupply?.sourceRef ?? null,
          internalSupplyAuditStatus: internalSupply?.auditStatus ?? "not_attempted",
          internalSupplyError,
          identityLink: internalSupply?.identityLink ?? null,
        });
      } catch (error) {
        reject("error", { error: error instanceof Error ? error.message : String(error) });
        console.warn("[supply-first] candidate rejected", {
          productId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (pageCompleted) {
      ({ queryIndex, page } = pageExhausted
        ? nextCatalogQuery(queryIndex, queries.length)
        : { queryIndex, page: page + 1 });
    }
  }
  await writeCatalogCursor(db, { queryIndex, page, verified, rejected, quotaBlocked: cjQuotaBlocked });

  return { discovered, published: 0, verified, rejected, candidateCount: candidateInputs.length, eligibleCount: seeded.length, deadlineReached, items };
}
