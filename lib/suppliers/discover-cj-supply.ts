import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import {
  fetchCJProductVariants,
  fetchCJVariantStock,
  getCJProductDetail,
  searchCJProducts,
  calculateCJFreight,
} from "@/lib/sources/cj";
import { selectUnambiguousVariant, type CJProductVariant } from "@/lib/sources/cj/variant-select";
import { persistCjSupplyIntelligence } from "@/lib/intelligence/persist-cj-supply-intelligence";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { persistCjInternalSupplyCandidate } from "@/lib/suppliers/persist-cj-internal-supply";

function yenPrice(costUsd: number, shippingUsd: number, fx: number): number {
  const landed = (costUsd + shippingUsd) * fx;
  const withMargin = Math.max(1980, landed * 2.5);
  return Math.ceil(withMargin / 100) * 100;
}

const CATALOG_QUERIES = [
  "skincare", "beauty", "makeup", "hair care", "hair tools", "women fashion",
  "women shoes", "women accessories", "jewelry", "handbag", "period care",
  "wellness", "self care", "beauty organizer", "cosmetic organizer",
  "jewelry organizer", "closet organizer", "garment steamer", "bathroom organization",
  "home organization", "kitchen", "pet", "phone accessories", "fitness",
  "lighting", "garden", "office", "outdoor", "car accessories",
];
const MAX_CATALOG_PAGES = 50;
const CATALOG_CURSOR_JOB = "supply-first-catalog-cursor";

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
  cursor: CatalogCursor & { verified: number; rejected: number },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from("cron_runs").insert({
    job_name: CATALOG_CURSOR_JOB,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: cursor.verified,
    failed: cursor.rejected,
    metadata: { queryIndex: cursor.queryIndex, page: cursor.page },
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
  internalSupplyIngested: number;
  internalSupplyFailed: number;
  identityLinked: number;
  identityUnlinked: number;
  auditWritten: number;
  auditMissing: number;
  auditWriteFailed: number;
  candidateCount: number;
  eligibleCount: number;
  deadlineReached: boolean;
  items: Array<Record<string, unknown>>;
}> {
  const db = createSupabaseAdminClient();

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
  let rejected = 0;
  let internalSupplyIngested = 0;
  let internalSupplyFailed = 0;
  let identityLinked = 0;
  let identityUnlinked = 0;
  let auditWritten = 0;
  let auditMissing = 0;
  let auditWriteFailed = 0;

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
    .select("id,product_id,title,supplier_product_id,supplier_variant_id,cost,inventory,inventory_confirmed,price_confirmed,verification_status,shipping_status,next_verification_at,verification_attempts")
    .eq("supplier", "cj")
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .in("verification_status", ["verified", "unverified", "retryable"])
    .order("verification_status", { ascending: true })
    .order("inventory", { ascending: false, nullsFirst: false })
    .limit(500);
  if (seededError) throw new Error(`supply-first candidate query failed: ${seededError.message}`);

  const seenSeedKeys = new Set<string>();
  const seeded = (seededRows ?? []).filter((row) => {
    const key = `${String(row.supplier_product_id)}:${String(row.supplier_variant_id)}`;
    if (existingVariants.has(key) || seenSeedKeys.has(key)) return false;
    seenSeedKeys.add(key);
    return true;
  });

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
  }));

  const seededVerificationLimit = Math.min(10, limit);
  for (const seededCandidate of candidateInputs) {
    if (verified >= seededVerificationLimit) break;
    if (Date.now() >= deadlineAt) {
      deadlineReached = true;
      break;
    }
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
      let detail = cachedTitle && cachedImageUrl
        ? { title: cachedTitle, imageUrl: cachedImageUrl, price: Number.isFinite(cachedPrice) ? cachedPrice : null }
        : await getCJProductDetail(candidate.id);

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
      // Reuse persisted variant/cost/inventory observations. Only image/title
      // and live Japan freight consume CJ requests for seeded rows.
      // Always re-check stock live: a persisted count may be days old and a
      // Every supply candidate must reflect current CJ stock.
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
          supplierProductId: candidate.id,
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
      const cost = Number(seededCandidate.cost ?? detail.price ?? cachedPrice);
      if (!Number.isFinite(cost) || cost <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: "cost_unavailable", attempts: seededCandidate.attempts });
        items.push({ rejectedStage: "cost_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, cost });
        continue;
      }
      const salePrice = yenPrice(cost, freight, fxRate);
      const seededVariants = await fetchCJProductVariants(candidate.id, { countryCode: "JP" });
      const seededVariant = seededVariants.find((item) => item.vid === candidate.variantId);
      const variantBarcode = typeof seededVariant?.barcode === "string" ? seededVariant.barcode : null;
      const displayTitle = localizeProductTitle(detail.title, query);
      if (!displayTitle) {
        rejected++;
        if (seededCandidate.supplierListingId) {
          await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: "japanese_display_title_unavailable", attempts: seededCandidate.attempts });
        }
        items.push({ rejectedStage: "japanese_display_title_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, sourceTitle: detail.title });
        continue;
      }
      const sourceRef = `cj:${candidate.id}:${candidate.variantId}`;
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
      const supplierInsert = await upsertSupplierListing(db, {
        supplier: "cj", external_id: candidate.variantId, sku: null, title: detail.title, product_id: productId,
        cost, shipping_cost: freight, currency: "USD", inventory: Math.floor(stock), ship_to: "JP",
        order_method: "cj_api", api_available: true, identity_method: "supply_discovered",
        identity_status: "supply_discovered", identity_confidence: 1, configured: true,
        supplier_product_id: candidate.id, supplier_variant_id: candidate.variantId, cj_variant_id: candidate.variantId,
        gtin: variantBarcode,
        orderable: true, price_confirmed: true, inventory_confirmed: true, tracking_available: cjTrackingAvailable,
        fetched_at: new Date().toISOString(), metadata: { source: "cj_supply_first", source_ref: sourceRef, query, fx_rate: fxRate }
      }, seededCandidate.supplierListingId);
      if (supplierInsert.error) throw new Error(supplierInsert.error.message);
      await markVerification(db, String(supplierInsert.data.id), { status: "verified", shippingStatus: "verified" });
      if (seededCandidate.supplierListingId && seededCandidate.supplierListingId !== String(supplierInsert.data.id)) {
        await markVerification(db, seededCandidate.supplierListingId, { status: "verified", shippingStatus: "verified" });
      }
      const intelligence = await persistCjSupplyIntelligence({
        productId,
        title: displayTitle,
        imageUrl: detail.imageUrl,
        cost,
        shippingCost: freight,
        supplierListingId: String(supplierInsert.data.id),
        supplierProductId: candidate.id,
        supplierVariantId: candidate.variantId,
        inventory: Math.floor(stock),
        query,
        fxRate,
        sellingPriceJpy: salePrice,
        variantBarcode,
      });
      let internalSupply: { productId: string; variantId: string; sourceRef: string; identityLink: { bestsellerId: string; method: string; rationale: string } | null; identityMatchStatus: "linked" | "missing_barcode" | "invalid_barcode" | "lookup_failed" | "candidate_search_overflow" | "no_exact_match" | "ambiguous_exact_match" | "link_write_failed"; auditStatus: "written" | "table_missing" | "write_failed" } | null = null;
      let internalSupplyError: string | null = null;
      try {
        internalSupply = await persistCjInternalSupplyCandidate({
          supplierProductId: candidate.id,
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
      if (internalSupply) {
        internalSupplyIngested++;
        if (internalSupply.identityLink) identityLinked++;
        else identityUnlinked++;
        if (internalSupply.auditStatus === "written") auditWritten++;
        else if (internalSupply.auditStatus === "table_missing") auditMissing++;
        else auditWriteFailed++;
      } else {
        internalSupplyFailed++;
      }
      discovered++;
      verified++;
      items.push({
        productId,
        supplierListingId: String(supplierInsert.data.id),
        offerId: intelligence.offerId,
        intelligenceId: intelligence.intelligenceId,
        title: displayTitle,
        supplierProductId: candidate.id,
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
        identityMatchStatus: internalSupply?.identityMatchStatus ?? (internalSupplyError ? "ingest_failed" : "not_attempted"),
      });
    } catch (error) {
      rejected++;
      const message = error instanceof Error ? error.message : String(error);
      items.push({ rejectedStage: "error", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, error: message });
      if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: message.slice(0, 500), attempts: seededCandidate.attempts });
      console.warn("[supply-first] seeded candidate rejected", { productId: candidate.id, error: message });
    }
  }

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
  const seenSearchProducts = new Set<string>();
  while (catalogDiscovered < limit && pagesScanned < queries.length * 2) {
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
      items.push({ rejectedStage: "catalog_search_failed", query, page, error: error instanceof Error ? error.message : String(error) });
      ({ queryIndex, page } = nextCatalogQuery(queryIndex, queries.length));
      continue;
    }
    const pageExhausted = search.products.length === 0 || page >= Math.min(search.totalPages, MAX_CATALOG_PAGES);
    const pageQuery = query;
    const pageNumber = page;
    let pageCompleted = true;
    for (const candidate of search.products.map((x) => ({ ...x, variantId: null as string | null }))) {
      if (catalogDiscovered >= limit || Date.now() >= deadlineAt) {
        if (Date.now() >= deadlineAt) deadlineReached = true;
        pageCompleted = false;
        break;
      }
      if (seenSearchProducts.has(candidate.id)) continue;
      seenSearchProducts.add(candidate.id);
      if (existingProducts.has(candidate.id)) continue;
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
        const detail = { title: candidate.title, imageUrl: candidate.imageUrl, price: candidate.price };

        const variants = await fetchCJProductVariants(candidate.id);
        // In supply-first the CJ variant itself is the sellable item, so a
        // multi-variant product is not ambiguous: pick one concrete variant
        // (cheapest priced) and name it explicitly in the listing title.
        const variant =
          (candidate.variantId
            ? variants.find((x) => x.vid === candidate.variantId)
            : null) ??
          selectUnambiguousVariant(variants) ??
          selectSupplyFirstVariant(variants);
        if (!variant?.vid) {
          reject("variant_unavailable", { variantCount: variants.length });
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
        const sourceRef = `cj:${candidate.id}:${variant.vid}`;
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
              product_id: productId,
              cost,
              shipping_cost: freight,
              currency: "USD",
              inventory: Math.floor(stock),
              ship_to: "JP",
              order_method: "cj_api",
              api_available: true,
              identity_method: "supply_discovered",
              identity_status: "supply_discovered",
              identity_confidence: 1,
              configured: true,
              supplier_product_id: candidate.id,
              supplier_variant_id: variant.vid,
              cj_variant_id: variant.vid,
              gtin: variantBarcode,
              orderable: true,
              price_confirmed: true,
              inventory_confirmed: true,
              tracking_available: cjTrackingAvailable,
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
          supplierProductId: candidate.id,
          supplierVariantId: variant.vid,
          inventory: Math.floor(stock),
          query,
          fxRate,
          sellingPriceJpy: salePrice,
          variantBarcode,
        });
        let internalSupply: { productId: string; variantId: string; sourceRef: string; identityLink: { bestsellerId: string; method: string; rationale: string } | null; identityMatchStatus: "linked" | "missing_barcode" | "invalid_barcode" | "lookup_failed" | "candidate_search_overflow" | "no_exact_match" | "ambiguous_exact_match" | "link_write_failed"; auditStatus: "written" | "table_missing" | "write_failed" } | null = null;
        let internalSupplyError: string | null = null;
        try {
          internalSupply = await persistCjInternalSupplyCandidate({
            supplierProductId: candidate.id,
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
      if (internalSupply) {
        internalSupplyIngested++;
        if (internalSupply.identityLink) identityLinked++;
        else identityUnlinked++;
        if (internalSupply.auditStatus === "written") auditWritten++;
        else if (internalSupply.auditStatus === "table_missing") auditMissing++;
        else auditWriteFailed++;
      } else {
        internalSupplyFailed++;
      }
        discovered++;
        verified++;
        catalogDiscovered++;
        items.push({
          productId,
          supplierListingId,
          offerId: intelligence.offerId,
          intelligenceId: intelligence.intelligenceId,
          title: displayTitle,
          supplierProductId: candidate.id,
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
        identityMatchStatus: internalSupply?.identityMatchStatus ?? (internalSupplyError ? "ingest_failed" : "not_attempted"),
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
  await writeCatalogCursor(db, { queryIndex, page, verified, rejected });

  return { discovered, published: 0, verified, rejected, internalSupplyIngested, internalSupplyFailed, identityLinked, identityUnlinked, auditWritten, auditMissing, auditWriteFailed, candidateCount: candidateInputs.length, eligibleCount: seeded.length, deadlineReached, items };
}
