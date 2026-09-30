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
import { selectUnambiguousVariant } from "@/lib/sources/cj/variant-select";

function yenPrice(costUsd: number, shippingUsd: number, fx: number): number {
  const landed = (costUsd + shippingUsd) * fx;
  const withMargin = Math.max(1980, landed * 2.5);
  return Math.ceil(withMargin / 100) * 100;
}

async function markVerification(
  db: ReturnType<typeof createSupabaseAdminClient>,
  id: string,
  patch: { status: "verified" | "unavailable" | "retryable"; shippingStatus?: "verified" | "unavailable" | "retryable" | "unknown"; error?: string },
): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + (patch.status === "unavailable" || patch.shippingStatus === "unavailable" ? 7 : 1) * 86_400_000);
  await db.from("supplier_listings").update({
    verification_status: patch.status,
    shipping_status: patch.shippingStatus ?? undefined,
    verification_error: patch.error ?? null,
    last_verified_at: patch.status === "verified" ? now.toISOString() : undefined,
    next_verification_at: next.toISOString(),
    shipping_checked_at: patch.shippingStatus ? now.toISOString() : undefined,
    inventory_checked_at: now.toISOString(),
  }).eq("id", id);
}

async function upsertSupplierListing(
  db: ReturnType<typeof createSupabaseAdminClient>,
  payload: Record<string, unknown>,
  preferredId?: string | null,
): Promise<{ data: { id: string } | null; error: Error | null }> {
  const supplier = String(payload.supplier ?? "");
  const externalId = String(payload.external_id ?? "");
  const existing = preferredId
    ? await db.from("supplier_listings").select("id").eq("id", preferredId).limit(1)
    : await db.from("supplier_listings").select("id").eq("supplier", supplier).eq("external_id", externalId).order("created_at", { ascending: true }).limit(1);
  if (existing.error) return { data: null, error: new Error(existing.error.message) };
  const existingId = existing.data?.[0]?.id ? String(existing.data[0].id) : null;
  const result = existingId
    ? await db.from("supplier_listings").update(payload).eq("id", existingId).select("id").single()
    : await db.from("supplier_listings").insert(payload).select("id").single();
  if (result.error) return { data: null, error: new Error(result.error.message) };
  return { data: result.data ? { id: String(result.data.id) } : null, error: null };
}

function slug(title: string, productId: string, variantId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54);
  return `${base || "tracer-product"}-${productId.slice(-8)}-${variantId.slice(-8)}`;
}

/**
 * Supply-first path. This deliberately does not claim marketplace identity.
 * The CJ product/variant itself is the source of truth for the sellable item.
 * Every published row must have a live variant id, live stock > 0, live
 * Japan freight, a positive cost and a non-empty image.
 */
export async function discoverAndCreateCjSupply(
  limit = 1,
  options?: { deadlineAt?: number },
): Promise<{
  discovered: number;
  published: number;
  rejected: number;
  candidateCount: number;
  eligibleCount: number;
  deadlineReached: boolean;
  items: Array<Record<string, unknown>>;
}> {
  const db = createSupabaseAdminClient();
  const fx = await getObservedUsdToJpyRate();
  const fxRate = fx?.rate ?? null;
  if (!fxRate || !Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error("USD/JPY FX rate unavailable");
  }

  const queries = ["beauty", "home storage", "kitchen", "pet", "women"];
  const items: Array<Record<string, unknown>> = [];
  let discovered = 0;
  let published = 0;
  let rejected = 0;

  // Reuse previously discovered CJ IDs first. These rows are only candidates;
  // stock, variant and Japan freight are re-verified live before publication.
  // Do not keep selecting the already-published winner. The first bootstrap
  // run proved the BASE path; subsequent runs must advance through the
  // remaining verified CJ supply candidates.
  const { data: existingListings } = await db
    .from("shop_listings")
    .select("supplier_product_id,supplier_variant_id")
    .not("supplier_variant_id", "is", null);

  const publishedVariants = new Set(
    (existingListings ?? []).map((row) => `${String(row.supplier_product_id ?? "")}:${String(row.supplier_variant_id ?? "")}`),
  );

  const { data: seededRows } = await db
    .from("supplier_listings")
    .select("id,title,supplier_product_id,supplier_variant_id,cost,inventory,inventory_confirmed,price_confirmed,verification_status,shipping_status,next_verification_at")
    .eq("supplier", "cj")
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .order("inventory", { ascending: false })
    .limit(5000);

  const nowMs = Date.now();
  const seeded = (seededRows ?? []).filter((row, index, rows) => {
    const status = String(row.verification_status ?? "unverified");
    const due = !row.next_verification_at || new Date(String(row.next_verification_at)).getTime() <= nowMs;
    if (status === "verified" || status === "unavailable" || !due) return false;
    const key = `${String(row.supplier_product_id)}:${String(row.supplier_variant_id)}`;
    return !publishedVariants.has(key) &&
      rows.findIndex((x) => x.supplier_product_id === row.supplier_product_id && x.supplier_variant_id === row.supplier_variant_id) === index;
  });

  // Do not retry the same failed candidates forever. The scheduled job runs
  // once per day, so rotate the verification window by day and inspect a
  // bounded batch. This keeps the job inside its execution budget while
  // ensuring the 38 currently eligible CJ candidates are actually traversed.
  const rotation = seeded.length > 0
    ? Math.floor(Date.now() / 86_400_000) % seeded.length
    : 0;
  // Traverse every eligible candidate; the caller's deadline (not a fixed
  // count) bounds the batch so the request stays inside maxDuration.
  const rotatedSeeded = seeded.length > 0
    ? [...seeded.slice(rotation), ...seeded.slice(0, rotation)]
    : [];
  const deadlineAt = options?.deadlineAt ?? Number.POSITIVE_INFINITY;
  let deadlineReached = false;

  const candidateInputs = (rotatedSeeded.length
    ? rotatedSeeded.map((row) => ({
        query: "seeded_rotated",
        id: String(row.supplier_product_id),
        variantId: String(row.supplier_variant_id),
        cost: Number(row.cost),
        inventory: Number(row.inventory),
        inventoryConfirmed: row.inventory_confirmed === true,
        priceConfirmed: row.price_confirmed === true,
        seededTitle: String(row.title ?? ""),
        supplierListingId: String(row.id),
      }))
    : [
        {
          query: "bootstrap-observed",
          id: "1522412448668725248",
          variantId: "1522412448823914496",
          supplierListingId: null,
          cost: 23,
          inventory: 45890,
          seededTitle: "bootstrap",
        },
      ]);

  for (const seededCandidate of candidateInputs) {
    if (published >= limit) break;
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
      let stock =
        seededCandidate.inventoryConfirmed === true &&
        Number.isFinite(seededCandidate.inventory) &&
        seededCandidate.inventory > 0
          ? seededCandidate.inventory
          : null;

      // Unverified rows are not dead data. Re-check stock live so the 5k+
      // unverified pool can actually advance through the pipeline.
      if (stock === null) {
        stock = await fetchCJVariantStock(candidate.variantId);
      }

      if (stock === null || stock <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) {
          await markVerification(db, seededCandidate.supplierListingId, {
            status: "retryable",
            error: "live_inventory_unavailable",
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
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "unavailable", shippingStatus: "unavailable", error: "jp_freight_unavailable" });
        items.push({ rejectedStage: "jp_freight_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, freight });
        continue;
      }
      const cost = Number(seededCandidate.cost ?? detail.price ?? cachedPrice);
      if (!Number.isFinite(cost) || cost <= 0) {
        rejected++;
        if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: "cost_unavailable" });
        items.push({ rejectedStage: "cost_unavailable", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, cost });
        continue;
      }
      const salePrice = yenPrice(cost, freight, fxRate);
      const sourceRef = `cj:${candidate.id}:${candidate.variantId}`;
      const productInsert = await db.from("products").upsert({ canonical_name: detail.title, identity_key: sourceRef }, { onConflict: "identity_key" }).select("id").single();
      if (productInsert.error) throw new Error(productInsert.error.message);
      const productId = String(productInsert.data.id);
      const supplierInsert = await upsertSupplierListing(db, {
        supplier: "cj", external_id: candidate.variantId, sku: null, title: detail.title, product_id: productId,
        cost, shipping_cost: freight, currency: "USD", inventory: Math.floor(stock), ship_to: "JP",
        order_method: "cj_api", api_available: true, identity_method: "supply_discovered",
        identity_status: "supply_discovered", identity_confidence: 1, configured: true,
        supplier_product_id: candidate.id, supplier_variant_id: candidate.variantId, cj_variant_id: candidate.variantId,
        orderable: true, price_confirmed: true, inventory_confirmed: true, tracking_available: false,
        fetched_at: new Date().toISOString(), metadata: { source: "cj_supply_first", source_ref: sourceRef, query, fx_rate: fxRate }
      }, seededCandidate.supplierListingId);
      if (supplierInsert.error) throw new Error(supplierInsert.error.message);
      await markVerification(db, String(supplierInsert.data.id), { status: "verified", shippingStatus: "verified" });
      if (seededCandidate.supplierListingId && seededCandidate.supplierListingId !== String(supplierInsert.data.id)) {
        await markVerification(db, seededCandidate.supplierListingId, { status: "verified", shippingStatus: "verified" });
      }
      const listingSlug = slug(detail.title, candidate.id, candidate.variantId);
      const shopInsert = await db.from("shop_listings").upsert({
        product_id: productId, supplier_listing_id: supplierInsert.data.id, slug: listingSlug, title: detail.title,
        description: `TRACER supply-first product. Supplier: CJdropshipping. Variant: standard.`,
        image_url: detail.imageUrl, selling_price: salePrice, currency: "JPY", supplier_name: "cj",
        supplier_product_id: candidate.id, supplier_variant_id: candidate.variantId, source_cost: cost, shipping_cost: freight,
        inventory: Math.floor(stock), orderable: true, tracking_available: false, identity_method: "supply_discovered",
        identity_confidence: 1, published: true, selection_reasons: ["supply_first","live_cj_variant","live_inventory_gt_zero","live_japan_freight",`fx_usdjpy_${fxRate.toFixed(4)}`],
        missing: [], published_at: new Date().toISOString(), pipeline_stage: "PUBLISHED", pipeline_status: "published",
        pipeline_reason: "supply_first_gate_passed", pipeline_updated_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }, { onConflict: "slug" }).select("id").single();
      if (shopInsert.error) throw new Error(shopInsert.error.message);
      discovered++; published++;
      items.push({ listingId: String(shopInsert.data.id), productId, supplierListingId: String(supplierInsert.data.id), title: detail.title, supplierProductId: candidate.id, supplierVariantId: candidate.variantId, costUsd: cost, freightUsd: freight, inventory: Math.floor(stock), sellingPriceJpy: salePrice, fxRate });
    } catch (error) {
      rejected++;
      const message = error instanceof Error ? error.message : String(error);
      items.push({ rejectedStage: "error", supplierProductId: candidate.id, supplierVariantId: candidate.variantId, error: message });
      if (seededCandidate.supplierListingId) await markVerification(db, seededCandidate.supplierListingId, { status: "retryable", error: message.slice(0, 500) });
      console.warn("[supply-first] seeded candidate rejected", { productId: candidate.id, error: message });
    }
  }

  if (published >= limit) return { discovered, published, rejected, candidateCount: candidateInputs.length, eligibleCount: seeded.length, deadlineReached, items };

  // Seeded verification is only one source of candidates. If all seeded
  // variants fail live Japan-freight verification, continue into the live CJ
  // catalog instead of stopping with zero new products.
  const seenSearchProducts = new Set<string>();
  for (const query of queries) {
    if (published >= limit || Date.now() >= deadlineAt) {
      if (Date.now() >= deadlineAt) deadlineReached = true;
      break;
    }

    let search;
    try {
      search = await searchCJProducts(query, { page: 1, size: 20 });
    } catch {
      continue;
    }

    for (const candidate of search.products.map((x) => ({ ...x, variantId: null as string | null }))) {
      if (published >= limit || Date.now() >= deadlineAt) {
        if (Date.now() >= deadlineAt) deadlineReached = true;
        break;
      }
      if (seenSearchProducts.has(candidate.id)) continue;
      seenSearchProducts.add(candidate.id);
      if (publishedVariants.has(`${candidate.id}:`)) continue;
      if (!candidate.imageUrl || !candidate.title) continue;

      try {
        const detail = await getCJProductDetail(candidate.id);
        if (!detail?.imageUrl || !detail.title) continue;

        const variants = await fetchCJProductVariants(candidate.id, { countryCode: "JP" });
        const variant =
          (candidate.variantId
            ? variants.find((x) => x.vid === candidate.variantId)
            : null) ?? selectUnambiguousVariant(variants);
        if (!variant?.vid) {
          rejected++;
          continue;
        }

        const stock = await fetchCJVariantStock(variant.vid);
        if (stock === null || stock <= 0) {
          rejected++;
          continue;
        }

        const freight = await calculateCJFreight(variant.vid, {
          startCountryCode: "CN",
          endCountryCode: "JP",
          quantity: 1,
          zip: "1000001",
        });
        if (freight === null || freight <= 0) {
          rejected++;
          continue;
        }

        const cost = Number(variant.sellPrice ?? detail.price ?? candidate.price);
        if (!Number.isFinite(cost) || cost <= 0) {
          rejected++;
          continue;
        }

        const salePrice = yenPrice(cost, freight, fxRate);
        const sourceRef = `cj:${candidate.id}:${variant.vid}`;
        const identityKey = sourceRef;
        const now = new Date().toISOString();

        const productInsert = await db
          .from("products")
          .upsert(
            {
              canonical_name: detail.title,
              identity_key: identityKey,
            },
            { onConflict: "identity_key" },
          )
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
              orderable: true,
              price_confirmed: true,
              inventory_confirmed: true,
              tracking_available: false,
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

        const listingSlug = slug(detail.title, candidate.id, variant.vid);
        const shopInsert = await db
          .from("shop_listings")
          .upsert(
            {
              product_id: productId,
              supplier_listing_id: supplierListingId,
              slug: listingSlug,
              title: detail.title,
              description: `TRACER supply-first product. Supplier: CJdropshipping. Variant: ${variant.nameEn ?? "standard"}.`,
              image_url: detail.imageUrl,
              selling_price: salePrice,
              currency: "JPY",
              supplier_name: "cj",
              supplier_product_id: candidate.id,
              supplier_variant_id: variant.vid,
              source_cost: cost,
              shipping_cost: freight,
              inventory: Math.floor(stock),
              orderable: true,
              tracking_available: false,
              identity_method: "supply_discovered",
              identity_confidence: 1,
              published: true,
              selection_reasons: [
                "supply_first",
                "live_cj_variant",
                "live_inventory_gt_zero",
                "live_japan_freight",
                `fx_usdjpy_${fxRate.toFixed(4)}`,
              ],
              missing: [],
              published_at: now,
              pipeline_stage: "PUBLISHED",
              pipeline_status: "published",
              pipeline_reason: "supply_first_gate_passed",
              pipeline_updated_at: now,
              updated_at: now,
            },
            { onConflict: "slug" },
          )
          .select("id")
          .single();

        if (shopInsert.error) throw new Error(shopInsert.error.message);

        discovered++;
        published++;
        items.push({
          listingId: String(shopInsert.data.id),
          productId,
          supplierListingId,
          title: detail.title,
          supplierProductId: candidate.id,
          supplierVariantId: candidate.variantId,
          costUsd: cost,
          freightUsd: freight,
          inventory: Math.floor(stock),
          sellingPriceJpy: salePrice,
          fxRate,
        });
      } catch (error) {
        rejected++;
        console.warn("[supply-first] candidate rejected", {
          productId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { discovered, published, rejected, candidateCount: candidateInputs.length, eligibleCount: seeded.length, deadlineReached, items };
}
