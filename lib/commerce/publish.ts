import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { addBaseItemImage, createBaseItem, editBaseItem, fetchBaseItemsSnapshot, getBasePublicShopUrl, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, updateShopifyProduct } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import { asRelationRows } from "@/lib/commerce/relation-rows";
import { resolveBasePublicUrl } from "@/lib/commerce/base-public-url.mjs";

type Channel = "base" | "shopify";
type SupplierOfferRow = { id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; supplier_url: string | null; currency: string; unit_cost: number; shipping_cost: number; raw_data: Record<string, unknown> | null; inventory: number; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null };
type CommercePriceRow = { supplier_offer_id: string; calculated_at: string; currency: string; selling_price: number; expected_profit: number; fee_amount: number; margin_rate: number };
type Candidate = {
  id: string; source_variant_key: string; title_ja: string; sku: string | null;
  commerce_products: { id: string; source_key: string; title_ja: string; description_ja: string; image_url: string | null; active: boolean };
  supplier_offers: SupplierOfferRow[] | SupplierOfferRow | null;
  commerce_prices: CommercePriceRow[] | CommercePriceRow | null;
};

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function safeSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "tracer-item";
}

async function unpublishUnfulfillableListings(channel: Channel, db: ReturnType<typeof createSupabaseAdminClient>) {
  const result = { checked: 0, unpublished: 0, failed: 0, errors: [] as string[] };
  const { data: listings, error } = await db.from("channel_listings")
    .select("id,variant_id,external_product_id,external_variant_id,status,last_error,last_synced_at")
    .eq("channel", channel).eq("status", "published")
    .not("external_product_id", "is", null)
    .order("last_synced_at", { ascending: true, nullsFirst: true }).limit(5);
  if (error) throw new Error("stale_listing_read_failed:" + error.message);

  // Only inspect currently published listings. Already-hidden error rows must not
  // occupy the bounded batch and starve later products.
  const checkableListings = listings ?? [];
  result.checked = checkableListings.length;
  const variantIds = [...new Set(checkableListings.map((listing) => String(listing.variant_id)).filter(Boolean))];
  if (variantIds.length === 0) return result;

  // Batch all reads before the external unpublish loop. The old per-listing pattern
  // made 1,000+ sequential Supabase requests for a 500-listing audit and timed out
  // before it could publish new products.
  const [pricesRead, offersRead, variantsRead] = await Promise.all([
    db.from("commerce_prices")
      .select("variant_id,supplier_offer_id,currency,selling_price,expected_profit,calculated_at")
      .in("variant_id", variantIds)
      .order("calculated_at", { ascending: false }),
    db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,raw_data,inventory,source_status,tracking_supported,ship_to,last_checked_at")
      .in("variant_id", variantIds)
      .order("last_checked_at", { ascending: false }),
    db.from("commerce_variants")
      .select("id,title_ja,commerce_products!inner(title_ja,description_ja)")
      .in("id", variantIds),
  ]);
  if (pricesRead.error) throw new Error("stale_price_batch_read_failed:" + pricesRead.error.message);
  if (offersRead.error) throw new Error("stale_supplier_offer_batch_read_failed:" + offersRead.error.message);
  if (variantsRead.error) throw new Error("stale_variant_batch_read_failed:" + variantsRead.error.message);

  type StalePrice = { variant_id: string; supplier_offer_id: string | null; currency: string; selling_price: number; expected_profit: number; calculated_at: string | null };
  type StaleOffer = { id: string; variant_id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; unit_cost: number; shipping_cost: number; raw_data: Record<string, unknown> | null; inventory: number; source_status: string; tracking_supported: boolean; ship_to: string; last_checked_at: string | null };
  type StaleVariant = { id: string; title_ja: string | null; commerce_products: { title_ja?: string | null; description_ja?: string | null } | Array<{ title_ja?: string | null; description_ja?: string | null }> | null };
  const pricesByVariant = new Map<string, StalePrice[]>();
  for (const price of (pricesRead.data ?? []) as StalePrice[]) {
    const rows = pricesByVariant.get(price.variant_id) ?? [];
    rows.push(price);
    pricesByVariant.set(price.variant_id, rows);
  }
  const offersByVariant = new Map<string, StaleOffer[]>();
  for (const offer of (offersRead.data ?? []) as StaleOffer[]) {
    const rows = offersByVariant.get(offer.variant_id) ?? [];
    rows.push(offer);
    offersByVariant.set(offer.variant_id, rows);
  }
  const variantsById = new Map(((variantsRead.data ?? []) as StaleVariant[]).map((variant) => [variant.id, variant]));

  for (const listing of checkableListings) {
    try {
      const prices = pricesByVariant.get(String(listing.variant_id)) ?? [];
      const offers = offersByVariant.get(String(listing.variant_id)) ?? [];
      const hasPublishableLinkedOffer = offers.some((offer) => {
        const price = prices.find((candidate) => candidate.supplier_offer_id === offer.id);
        const nativeIdsValid = offer.supplier_code !== "cj" ||
          (isCanonicalCjNativeId(offer.supplier_product_id) && isCanonicalCjNativeId(offer.supplier_variant_id));
        // Listing eligibility uses exact supplier identity and a positive JPY landed-cost price.
        // Cached stock, verification age, JP destination and tracking are rechecked at procurement,
        // so temporary supplier evidence gaps do not silently hide otherwise linked catalog items.
        const unitCostKnown = Number.isFinite(Number(offer.unit_cost)) && Number(offer.unit_cost) > 0;
        const shippingKnown = Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) > 0 ||
          (Number(offer.shipping_cost) === 0 && offer.raw_data?.shippingKnown === true);
        return Boolean(
          offer.supplier_product_id && offer.supplier_variant_id && nativeIdsValid &&
          unitCostKnown && shippingKnown &&
          price && price.currency === "JPY" && Number(price.selling_price) > 0 && Number(price.expected_profit) > 0
        );
      });
      if (hasPublishableLinkedOffer) {
        // Only exact supplier product/variant identity and profitable JPY pricing gate a listing.
        // Live stock, freshness, destination, tracking and orderability belong to procurement.
        const checkedAt = new Date().toISOString();
        const { error: markCheckedError } = await db.from("channel_listings").update({
          last_synced_at: checkedAt,
          updated_at: checkedAt,
          ...(hasPublishableLinkedOffer ? { last_error: null } : {}),
        }).eq("id", listing.id);
        if (markCheckedError) throw new Error("stale_listing_check_timestamp_failed:" + markCheckedError.message);
        continue;
      }

      const offer = offers[0] ?? null;
      const price = (offer ? prices.find((candidate) => candidate.supplier_offer_id === offer.id) : null) ?? prices[0] ?? null;
      const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
      const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
      const nativeIdsValid = offer?.supplier_code !== "cj" ||
        (isCanonicalCjNativeId(offer?.supplier_product_id) && isCanonicalCjNativeId(offer?.supplier_variant_id));
      const reason = !offer ? "supplier_offer_missing" :
        !nativeIdsValid ? "supplier_native_ids_invalid" :
        offer.source_status !== "verified" ? "supplier_offer_not_verified" :
        offer.tracking_supported !== true ? "tracking_not_verified" :
        offer.ship_to !== "JP" ? "supplier_not_shipping_to_japan" :
        !fresh ? "supplier_verification_stale" :
        Number(offer.inventory) <= 0 ? "supplier_out_of_stock" :
        !price || price.currency !== "JPY" || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0 ? "price_not_profitable" : "supplier_offer_invalid";

      const variant = variantsById.get(String(listing.variant_id));
      const product = asRelationRows(variant?.commerce_products)[0] ?? null;
      const title = String(variant?.title_ja || product?.title_ja || "TRACER商品");
      const detail = String(product?.description_ja || title);
      if (channel === "base") {
        await editBaseItem({
          itemId: String(listing.external_product_id), title, detail,
          price: Math.max(1, Math.round(Number(price?.selling_price) || 1)),
          stock: 0, visible: false,
        });
      } else {
        const productId = toShopifyGid("Product", String(listing.external_product_id));
        if (!productId) throw new Error("shopify_product_id_missing");
        const updated = await shopifyGraphQL<{
          productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
        }>(
          "mutation TracerHideUnfulfillable($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
          { input: { id: productId, status: "DRAFT" } },
        );
        if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
          throw new Error("shopify_unpublish_failed:" + (updated.productUpdate.userErrors.map((x) => x.message).join("; ") || "product_missing"));
        }
        if (listing.external_variant_id) {
          try {
            await setShopifyVariantInventory({
              variantId: String(listing.external_variant_id), quantity: 0,
              reference: "stale-supplier-offer:" + String(listing.variant_id),
            });
          } catch (inventoryError) {
            result.errors.push(String(listing.id) + ":inventory_zero_failed:" + (inventoryError instanceof Error ? inventoryError.message : String(inventoryError)).slice(0, 120));
          }
        }
      }
      const { error: saveError } = await db.from("channel_listings").update({
        status: "error",
        last_error: "supplier_offer_no_longer_fulfillable:" + reason,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", listing.id);
      if (saveError) throw new Error("stale_listing_state_save_failed:" + saveError.message);
      result.unpublished++;
    } catch (error) {
      result.failed++;
      result.errors.push(String(listing.id) + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
    }
  }
  return result;
}

export async function syncCommerceListings(channel: Channel, limit = 10, onlyUnpublished = true, variantIds?: string[]) {
  // Storefront publication is independent of supplier purchasing. Only the paid-order
  // procurement path is gated by liveOrdering; a sandbox proof must not block listings.
  if (channel === "base" && !isBaseConfigured()) throw new Error("base_oauth_not_configured");
  if (channel === "shopify" && !isShopifyConfigured()) throw new Error("shopify_not_configured");
  const db = createSupabaseAdminClient();
  let basePublicShopUrl = process.env.BASE_PUBLIC_SHOP_URL?.trim() ?? "";
  if (channel === "base" && !basePublicShopUrl) {
    try {
      basePublicShopUrl = (await getBasePublicShopUrl()) ?? "";
    } catch (error) {
      // A missing public URL must never block publication; it only omits the outbound URL in our dashboard.
      console.warn("[commerce-publish] BASE public shop URL lookup failed", {
        error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
    }
  }
  // Keep profitable items in the catalog, but disable external purchase until the exact priced offer has verified stock and Japan-bound freight.
  const staleListings = { checked: 0, unpublished: 0, failed: 0, errors: [] as string[] };
  let candidateQuery = db.from("commerce_variants")
    .select("id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,supplier_url,currency,unit_cost,shipping_cost,raw_data,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices!inner(supplier_offer_id,calculated_at,currency,selling_price,expected_profit,fee_amount,margin_rate)")
    .eq("commerce_products.active", true).eq("commerce_prices.currency", "JPY")
    .gt("commerce_prices.expected_profit", 0).gte("commerce_prices.margin_rate", 0.5);
  if (variantIds?.length) candidateQuery = candidateQuery.in("id", [...new Set(variantIds)]);
  const { data, error } = await candidateQuery.order("updated_at", { ascending: false }).limit(1000);
  if (error) throw new Error("commerce_candidates_read_failed:" + error.message);
  const allCandidates = (data ?? []) as unknown as Candidate[];
  const { data: listingStates, error: stateError } = await db.from("channel_listings")
    .select("variant_id,status,last_synced_at,external_product_id,external_variant_id,last_error").eq("channel", channel)
    .in("variant_id", allCandidates.map((row) => row.id));
  if (stateError) throw new Error("commerce_listing_state_read_failed:" + stateError.message);
  const stateByVariant = new Map((listingStates ?? []).map((row) => [String(row.variant_id), row]));
  const rank = (row: Candidate) => {
    const state = stateByVariant.get(row.id);
    if (!state) return 0;
    if (state.status === "pending") return 1;
    if (state.status === "error") return 2;
    return 3;
  };
  const sortedCandidates = [...allCandidates].sort((a, b) => {
    const priority = rank(a) - rank(b);
    if (priority !== 0) return priority;
    const aTime = stateByVariant.get(a.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(a.id)?.last_synced_at)) : 0;
    const bTime = stateByVariant.get(b.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(b.id)?.last_synced_at)) : 0;
    return aTime - bTime;
  });
  // Recovery runs should publish missing/pending/error listings only. Reprocessing
  // already-published products repeatedly resets their status to pending and wastes
  // the channel API budget without increasing the public catalog.
  const candidatesToProcess = onlyUnpublished
    ? sortedCandidates.filter((candidate) => stateByVariant.get(candidate.id)?.status !== "published")
    : sortedCandidates;
  const candidates = candidatesToProcess.slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  type BaseSnapshotItem = Record<string, unknown>;
  let baseSnapshotItems: BaseSnapshotItem[] | null = null;
  let baseSnapshotFailure: string | null = null;
  // A full 5,000-item BASE scan is only needed to recover an interrupted
  // create for a listing that already existed in our ledger. A brand-new variant
  // has no previous external item to recover, so create it directly with its stable SKU.
  if (channel === "base" && candidates.some((candidate) => {
    const state = stateByVariant.get(candidate.id);
    return Boolean(state && !state.external_product_id);
  })) {
    try {
      const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
      if (snapshot.complete !== true || !Array.isArray(snapshot.items)) throw new Error("base_create_recovery_snapshot_incomplete");
      baseSnapshotItems = snapshot.items as unknown as BaseSnapshotItem[];
    } catch (error) {
      baseSnapshotFailure = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
  }
  const baseItemsById = new Map<string, BaseSnapshotItem>();
  for (const item of baseSnapshotItems ?? []) {
    const id = String(item.item_id ?? "").trim();
    if (id) baseItemsById.set(id, item);
  }
  const results: Array<{ variantId: string; ok: boolean; externalId?: string; error?: string; action?: "published" | "unpublished" }> = [];
  for (const candidate of candidates) {
    const product = candidate.commerce_products;
    const validOffers = asRelationRows(candidate.supplier_offers)
      .filter((x) => {
        const nativeIdsValid = x.supplier_code !== "cj" ||
          (isCanonicalCjNativeId(x.supplier_product_id) && isCanonicalCjNativeId(x.supplier_variant_id));
        const unitCostKnown = Number.isFinite(Number(x.unit_cost)) && Number(x.unit_cost) > 0;
        const shippingKnown = Number.isFinite(Number(x.shipping_cost)) && Number(x.shipping_cost) > 0 ||
          (Number(x.shipping_cost) === 0 && x.raw_data?.shippingKnown === true);
        return Boolean(x.supplier_product_id && x.supplier_variant_id && nativeIdsValid && unitCostKnown && shippingKnown);
      });
    const allOffers = asRelationRows(candidate.supplier_offers);
    const currentPriceRows = asRelationRows(candidate.commerce_prices).sort((a, b) =>
      Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")),
    );
    const currentCanonicalPrice = currentPriceRows[0];
    const currentPriceOfferId = String(currentCanonicalPrice?.supplier_offer_id ?? "");
    const currentPriceOffer = currentPriceOfferId
      ? validOffers.find((candidateOffer) => String(candidateOffer.id) === currentPriceOfferId)
      : undefined;
    const price = currentCanonicalPrice && currentPriceOffer &&
      currentCanonicalPrice.currency === "JPY" &&
      Number(currentCanonicalPrice.selling_price) > 0 &&
      Number(currentCanonicalPrice.expected_profit) > 0
      ? currentCanonicalPrice
      : undefined;
    const offer = price ? currentPriceOffer : undefined;
    const imageUrl = safeUrl(product.image_url);
    const title = candidate.title_ja.trim() || product.title_ja.trim();
    const rawOffer = currentPriceOfferId
      ? allOffers.find((candidateOffer) => String(candidateOffer.id) === currentPriceOfferId) ?? null
      : null;
    const preflightRawOfferData = rawOffer?.raw_data && typeof rawOffer.raw_data === "object" && !Array.isArray(rawOffer.raw_data)
      ? rawOffer.raw_data as Record<string, unknown>
      : {};
    const preflightShippingKnown =
      (Number.isFinite(Number(rawOffer?.shipping_cost)) && Number(rawOffer?.shipping_cost) > 0) ||
      preflightRawOfferData.shippingKnown === true;
    const preflightStockKnown = preflightRawOfferData.stockKnown === true ||
      (preflightRawOfferData.stockKnown === undefined && rawOffer?.source_status === "verified");
    const supplierEvidenceUnverified = !rawOffer || rawOffer.source_status !== "verified" ||
      !preflightShippingKnown || !preflightStockKnown;
    const currentState = stateByVariant.get(candidate.id);
    if (!onlyUnpublished && currentState?.status === "published" && currentState.external_product_id && supplierEvidenceUnverified) {
      const reason = !rawOffer ? "supplier_offer_missing" :
        rawOffer.source_status !== "verified" ? "supplier_offer_not_verified" :
        !preflightShippingKnown ? "japan_freight_unconfirmed" : "supplier_stock_unconfirmed";
      const nowIso = new Date().toISOString();
      try {
        const fallbackPrice = Math.max(1, Math.round(Number(asRelationRows(candidate.commerce_prices)[0]?.selling_price) || 1));
        if (channel === "base") {
          await editBaseItem({
            itemId: String(currentState.external_product_id),
            title,
            detail: String(product.description_ja || title) + "\n\n仕入先の在庫・日本向け送料を確認中のため、現在購入できません。",
            price: fallbackPrice,
            stock: 0,
            visible: false,
          });
        } else {
          const productId = toShopifyGid("Product", String(currentState.external_product_id));
          if (!productId) throw new Error("shopify_product_id_missing");
          const updated = await shopifyGraphQL<{
            productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
          }>(
            "mutation TracerHideUnfulfillable($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
            { input: { id: productId, status: "DRAFT" } },
          );
          if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
            throw new Error("shopify_unpublish_failed:" + (updated.productUpdate.userErrors.map((x) => x.message).join("; ") || "product_missing"));
          }
          if (currentState.external_variant_id) {
            await setShopifyVariantInventory({
              variantId: String(currentState.external_variant_id),
              quantity: 0,
              reference: "unverified-supplier-offer:" + candidate.id,
            });
          }
        }
        const { error: saveError } = await db.from("channel_listings").update({
          status: "error",
          last_error: "supplier_offer_not_fulfillable:" + reason,
          last_synced_at: nowIso,
          updated_at: nowIso,
        }).eq("channel", channel).eq("variant_id", candidate.id);
        if (saveError) throw new Error("supplier_offer_disable_state_save_failed:" + saveError.message);
        staleListings.checked++;
        staleListings.unpublished++;
        stateByVariant.set(candidate.id, {
          ...currentState,
          status: "error",
          last_error: "supplier_offer_not_fulfillable:" + reason,
          last_synced_at: nowIso,
        });
        results.push({ variantId: candidate.id, ok: true, externalId: String(currentState.external_product_id), action: "unpublished" });
      } catch (error) {
        staleListings.checked++;
        staleListings.failed++;
        const message = error instanceof Error ? error.message : String(error);
        staleListings.errors.push(candidate.id + ":" + message.slice(0, 160));
        await db.from("channel_listings").update({
          last_error: "supplier_offer_disable_failed:" + reason + ":" + message.slice(0, 120),
          updated_at: nowIso,
        }).eq("channel", channel).eq("variant_id", candidate.id);
        results.push({ variantId: candidate.id, ok: false, error: "supplier_offer_disable_failed:" + reason });
      }
      continue;
    }
    if (!offer || !imageUrl || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0) {
      results.push({ variantId: candidate.id, ok: false, error: !offer ? "supplier_offer_missing_or_cost_unknown" : !imageUrl ? "image_url_invalid" : "price_not_profitable" });
      continue;
    }
    // Never manufacture storefront inventory. A listing can remain visible, but it is
    // purchasable only when supplier stock and Japan-bound shipping are evidenced.
    const rawOfferData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const supplierShippingKnown =
      (Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) > 0) ||
      rawOfferData.shippingKnown === true;
    const supplierStockKnown = rawOfferData.stockKnown === true ||
      (rawOfferData.stockKnown === undefined && offer.source_status === "verified");
    const supplierCheckedAt = typeof offer.last_checked_at === "string"
      ? Date.parse(offer.last_checked_at)
      : Number.NaN;
    const supplierEvidenceFresh = Number.isFinite(supplierCheckedAt) &&
      supplierCheckedAt <= Date.now() + 5 * 60_000 &&
      Date.now() - supplierCheckedAt <= 24 * 60 * 60_000;
    const supplierSaleable = supplierShippingKnown && supplierStockKnown &&
      offer.source_status === "verified" &&
      offer.ship_to === "JP" &&
      offer.tracking_supported === true &&
      supplierEvidenceFresh &&
      Number.isFinite(Number(offer.inventory)) && Number(offer.inventory) > 0;
    const storefrontStock = toStorefrontStockQuantity(
      supplierSaleable ? Number(offer.inventory) : 0,
      getStorefrontStockCap(),
    );
    if (!isJapaneseProductTitle(title)) {
      results.push({ variantId: candidate.id, ok: false, error: "japanese_product_title_invalid" });
      continue;
    }
    const description = (product.description_ja || title + "。商品仕様・配送条件は仕入先の最新情報をご確認ください。").trim();
    // Do not promise free shipping until Japan-bound shipping is evidenced.
    const storefrontDescription = supplierShippingKnown
      ? `${description}\n\n送料込み・送料無料。送料は商品価格に含まれています。`
      : `${description}\n\n現在、仕入先の日本向け送料を再確認中のため、購入できません。確認が完了次第、販売を再開します。`;
    const sku = "TRC-" + candidate.id.replace(/-/g, "").slice(0, 24).toUpperCase();
    let baseCreateIdNeedsRecovery: string | null = null;
    try {
      const { data: listing, error: listingError } = await db.from("channel_listings").upsert({
        variant_id: candidate.id, channel, selling_price: Math.round(Number(price.selling_price)),
        external_sku: sku, status: "pending", updated_at: new Date().toISOString()
      }, { onConflict: "channel,variant_id" }).select("id,external_product_id,external_variant_id,last_error").single();
      if (listingError || !listing) throw new Error("listing_claim_failed:" + (listingError?.message ?? "no_row"));
      let externalProductId = listing.external_product_id ? String(listing.external_product_id) : null;
      let externalVariantId = listing.external_variant_id ? String(listing.external_variant_id) : null;
      let publishedUrl: string | null = null;
      if (channel === "base" && !externalProductId) {
        const markerId = String(listing.last_error ?? "").match(/^base_create_id_persist_failed:([^:]+)(?::|$)/)?.[1] ?? null;
        let recoveredId = markerId;
        if (markerId && baseSnapshotItems && !baseItemsById.has(markerId)) throw new Error("base_create_marker_item_not_found:" + markerId);
        if (!recoveredId && stateByVariant.has(candidate.id)) {
          // Existing pending/error rows may represent a timed-out BASE create.
          // Require a complete snapshot before retrying them, to avoid duplicates.
          if (!baseSnapshotItems) throw new Error("base_create_recovery_snapshot_unavailable:" + (baseSnapshotFailure ?? "unknown"));
          const exactMatches = baseSnapshotItems.filter((item) => String(item.identifier ?? "").trim().toUpperCase() === sku);
          if (exactMatches.length > 1) throw new Error("base_identifier_ambiguous:" + sku);
          if (exactMatches.length === 1) recoveredId = String(exactMatches[0].item_id ?? "").trim() || null;
        }
        if (recoveredId) {
          baseCreateIdNeedsRecovery = recoveredId;
          const [skuLinks, idLinks] = await Promise.all([
            db.from("channel_listings").select("id,variant_id,external_product_id").eq("channel", "base").eq("external_sku", sku),
            db.from("channel_listings").select("id,variant_id").eq("channel", "base").eq("external_product_id", recoveredId),
          ]);
          if (skuLinks.error) throw new Error("base_recovery_sku_link_read_failed:" + skuLinks.error.message);
          if (idLinks.error) throw new Error("base_recovery_item_link_read_failed:" + idLinks.error.message);
          if ((skuLinks.data ?? []).some((row) => String(row.id) !== String(listing.id) && String(row.variant_id) !== String(candidate.id))) throw new Error("base_sku_already_mapped_to_other_variant:" + sku);
          if ((idLinks.data ?? []).some((row) => String(row.id) !== String(listing.id) && String(row.variant_id) !== String(candidate.id))) throw new Error("base_item_already_mapped_to_other_variant:" + recoveredId);
          const { data: recovered, error: recoverError } = await db.from("channel_listings")
            .update({ external_product_id: recoveredId, last_error: null, updated_at: new Date().toISOString() })
            .eq("id", listing.id).is("external_product_id", null).select("id").maybeSingle();
          if (recoverError) throw new Error("base_existing_item_id_save_failed:" + recoverError.message);
          if (!recovered) {
            const { data: current, error: currentError } = await db.from("channel_listings").select("external_product_id").eq("id", listing.id).maybeSingle();
            if (currentError || String(current?.external_product_id ?? "") !== recoveredId) throw new Error("base_existing_item_id_recovery_race:" + recoveredId);
          }
          externalProductId = recoveredId;
          baseCreateIdNeedsRecovery = null;
        }
      }
      if (channel === "base") {
        let baseResponse: unknown = null;
        const itemId = externalProductId;
        if (itemId) {
          baseResponse = await editBaseItem({ itemId, title, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          externalProductId = itemId;
        } else {
          const response = await createBaseItem({ title, identifier: sku, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          baseResponse = response;
          const returned = response.item?.item_id ?? response.item_id;
          externalProductId = String(returned ?? "");
          if (!externalProductId) throw new Error("base_item_id_missing");
          // Preserve the exact returned ID if persistence fails; the next run can recover it.
          baseCreateIdNeedsRecovery = externalProductId;
          const { error: saveCreatedIdError } = await db.from("channel_listings").update({
            external_product_id: externalProductId, external_sku: sku, status: "pending",
            last_error: null, updated_at: new Date().toISOString()
          }).eq("id", listing.id);
          if (saveCreatedIdError) throw new Error("base_created_item_id_save_failed:" + saveCreatedIdError.message);
          baseCreateIdNeedsRecovery = null;
        }
        await addBaseItemImage({ itemId: externalProductId, imageNo: 1, imageUrl });
        // Only make the item visible after the external ID and image are saved.
        const visibleResponse = await editBaseItem({ itemId: externalProductId, title, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: true });
        publishedUrl = resolveBasePublicUrl(visibleResponse, externalProductId, basePublicShopUrl)
          ?? resolveBasePublicUrl(baseResponse, externalProductId, basePublicShopUrl);
      } else {
        // Use the full stable variant UUID in the handle. Eight characters collided in the live catalog,
        // and Shopify rejects a duplicate handle even when the SKU differs.
        const handle = safeSlug(product.source_key + "-" + candidate.id.replace(/-/g, ""));
        const productId = toShopifyGid("Product", externalProductId);
        const variantId = toShopifyGid("ProductVariant", externalVariantId);
        type RecoveredShopifyProduct = { id: string; handle: string; vendor?: string | null; tags?: string[]; variants: { nodes: Array<{ id: string; sku?: string | null }> } };
        const isTracerProduct = (item: RecoveredShopifyProduct) => item.vendor === "TRACER" || (item.tags ?? []).includes("TRACER");
        const findTracerProducts = async (query: string) => {
          const found = await shopifyGraphQL<{ products: { nodes: RecoveredShopifyProduct[] } }>(
            `query CommerceRecoverProduct($query: String!) { products(first: 5, query: $query) { nodes { id handle vendor tags variants(first: 10) { nodes { id sku } } } } }`,
            { query },
          );
          return (found.products?.nodes ?? []).filter(isTracerProduct);
        };
        let recoveredProduct: RecoveredShopifyProduct | null = null;
        if (!productId || !variantId) {
          // Recover an external create whose response was lost before the DB ID was saved.
          // The current handle, the exact SKU, and the legacy 8-character handle are checked
          // separately. A SKU that belongs to more than one TRACER product is not adopted.
          const byHandle = (await findTracerProducts("handle:" + handle)).filter((item) =>
            (item.variants?.nodes ?? []).some((variant) => variant.sku === sku),
          );
          if (byHandle.length > 1) throw new Error("shopify_handle_ambiguous:" + handle);
          recoveredProduct = byHandle[0] ?? null;
          if (!recoveredProduct) {
            const bySku = (await findTracerProducts("sku:" + sku)).filter((item) =>
              (item.variants?.nodes ?? []).some((variant) => variant.sku === sku),
            );
            if (bySku.length > 1) throw new Error("shopify_sku_ambiguous:" + sku);
            recoveredProduct = bySku[0] ?? null;
          }
          if (!recoveredProduct) {
            const legacyHandle = safeSlug(product.source_key + "-" + candidate.id.slice(0, 8));
            if (legacyHandle !== handle) {
              const byLegacyHandle = await findTracerProducts("handle:" + legacyHandle);
              if (byLegacyHandle.length > 1) throw new Error("shopify_legacy_handle_ambiguous:" + legacyHandle);
              const legacy = byLegacyHandle[0] ?? null;
              const legacyVariants = legacy?.variants?.nodes ?? [];
              const skuMatches = legacyVariants.some((variant) => variant.sku === sku);
              const skuUnset = legacyVariants.length === 1 && !legacyVariants[0]?.sku;
              if (legacy && (skuMatches || skuUnset)) recoveredProduct = legacy;
              else if (legacy) throw new Error("shopify_legacy_handle_sku_mismatch:" + legacyHandle);
            }
          }
        }
        const recoveredVariantId = recoveredProduct?.variants.nodes.find((variant) => variant.sku === sku)?.id ?? null;
        const productResult = productId && variantId
          ? await updateShopifyProduct({ productId, title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), variantId, sku, imageUrl: null })
          : recoveredProduct && recoveredVariantId
            ? await updateShopifyProduct({ productId: recoveredProduct.id, title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), variantId: recoveredVariantId, sku, imageUrl: null })
            : await createShopifyProduct({ title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), sku, imageUrl });
        externalProductId = productResult.id;
        const variant = productResult.variants?.nodes?.[0];
        if (!variant?.id) throw new Error("shopify_variant_id_missing");
        externalVariantId = variant.id;
        await setShopifyVariantInventory({ variantId: variant.id, quantity: storefrontStock, reference: "commerce-core:" + candidate.id });
        const publication = await ensureShopifyProductPublished(productResult.id);
        if (!publication.published) throw new Error("shopify_publication_not_confirmed");
        publishedUrl = "https://" + String(process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "") + "/products/" + productResult.handle;
      }
      // BASE exposes a single sellable item, not a separate variant resource.
      // Mirror its item ID into external_variant_id as the sellable-unit key; order
      // ingestion continues to match the actual BASE order line by external_product_id.
      const mappedExternalVariantId = channel === "base" ? externalProductId : externalVariantId;
      const { error: finishError } = await db.from("channel_listings").update({
        external_product_id: externalProductId, external_variant_id: mappedExternalVariantId, external_sku: sku,
        selling_price: Number(price.selling_price),
        status: "published", published_url: publishedUrl, last_error: null, last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", listing.id);
      if (finishError) throw new Error("listing_result_save_failed:" + finishError.message);
      results.push({ variantId: candidate.id, ok: true, externalId: externalProductId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverableBaseError = channel === "base" && baseCreateIdNeedsRecovery
        ? ("base_create_id_persist_failed:" + baseCreateIdNeedsRecovery + ":" + message).slice(0, 1500)
        : message.slice(0, 1500);
      const { error: recordError } = await db.from("channel_listings").update({ status: "error", last_error: recoverableBaseError, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("variant_id", candidate.id).eq("channel", channel);
      if (recordError) console.error("[commerce-publish] failed to record channel error", { variantId: candidate.id, channel, error: recordError.message });
      results.push({ variantId: candidate.id, ok: false, error: message.slice(0, 300) });
    }
  }
  return { channel, staleListings, considered: candidates.length, published: results.filter((x) => x.ok && x.action !== "unpublished").length, processed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}
