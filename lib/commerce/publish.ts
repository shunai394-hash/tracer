import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { addBaseItemImage, createBaseItem, editBaseItem, getBasePublicShopUrl, isBaseConfigured } from "@/lib/channels/base";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, updateShopifyProduct } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import { asRelationRows } from "@/lib/commerce/relation-rows";
import { resolveBasePublicUrl } from "@/lib/commerce/base-public-url.mjs";

type Channel = "base" | "shopify";
type SupplierOfferRow = { id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; supplier_url: string | null; currency: string; unit_cost: number; shipping_cost: number; inventory: number; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null };
type CommercePriceRow = { supplier_offer_id: string; currency: string; selling_price: number; expected_profit: number; fee_amount: number; margin_rate: number };
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
    .select("id,variant_id,external_product_id,external_variant_id,status,last_error")
    .eq("channel", channel).in("status", ["published", "error"])
    .not("external_product_id", "is", null).limit(500);
  if (error) throw new Error("stale_listing_read_failed:" + error.message);
  for (const listing of listings ?? []) {
    if (listing.status === "error" && String(listing.last_error ?? "").startsWith("supplier_offer_no_longer_fulfillable:")) continue;
    result.checked++;
    try {
      const { data: price, error: priceError } = await db.from("commerce_prices")
        .select("supplier_offer_id,selling_price,expected_profit")
        .eq("variant_id", listing.variant_id).maybeSingle();
      if (priceError) throw new Error("price_read_failed:" + priceError.message);
      const { data: offer, error: offerError } = price?.supplier_offer_id
        ? await db.from("supplier_offers").select("supplier_code,supplier_product_id,supplier_variant_id,inventory,source_status,tracking_supported,ship_to,last_checked_at")
            .eq("id", price.supplier_offer_id).maybeSingle()
        : { data: null, error: null };
      if (offerError) throw new Error("supplier_offer_read_failed:" + offerError.message);
      const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
      const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
      const nativeIdsValid = offer?.supplier_code !== "cj" ||
        (isCanonicalCjNativeId(offer.supplier_product_id) && isCanonicalCjNativeId(offer.supplier_variant_id));
      const valid = Boolean(offer && price && offer.source_status === "verified" &&
        nativeIdsValid && offer.tracking_supported === true && offer.ship_to === "JP" && fresh &&
        Number(offer.inventory) > 0 && Number(price.selling_price) > 0 && Number(price.expected_profit) > 0);
      if (valid) continue;
      const reason = !offer ? "supplier_offer_missing" :
        !nativeIdsValid ? "supplier_native_ids_invalid" :
        offer.source_status !== "verified" ? "supplier_offer_not_verified" :
        offer.tracking_supported !== true ? "tracking_not_verified" :
        offer.ship_to !== "JP" ? "supplier_not_shipping_to_japan" :
        !fresh ? "supplier_verification_stale" :
        Number(offer.inventory) <= 0 ? "supplier_out_of_stock" :
        !price || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0 ? "price_not_profitable" : "supplier_offer_invalid";
      const { data: variant, error: variantError } = await db.from("commerce_variants")
        .select("title_ja,commerce_products!inner(title_ja,description_ja)")
        .eq("id", listing.variant_id).maybeSingle();
      if (variantError) throw new Error("product_title_read_failed:" + variantError.message);
      const product = variant?.commerce_products as unknown as { title_ja?: string; description_ja?: string } | null;
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
            // Drafting the product is the primary safety action; retain a visible diagnostic if inventory reset also fails.
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

export async function syncCommerceListings(channel: Channel, limit = 10) {
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
  const staleListings = await unpublishUnfulfillableListings(channel, db);
  const { data, error } = await db.from("commerce_variants")
    .select("id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,supplier_url,currency,unit_cost,shipping_cost,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices!inner(supplier_offer_id,currency,selling_price,expected_profit,fee_amount,margin_rate)")
    .eq("commerce_products.active", true).eq("supplier_offers.ship_to", "JP")
    .eq("supplier_offers.source_status", "verified").eq("supplier_offers.tracking_supported", true)
    .gte("supplier_offers.last_checked_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .gt("supplier_offers.inventory", 0).eq("commerce_prices.currency", "JPY")
    .gt("commerce_prices.expected_profit", 0).order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error("commerce_candidates_read_failed:" + error.message);
  const allCandidates = (data ?? []) as unknown as Candidate[];
  const { data: listingStates, error: stateError } = await db.from("channel_listings")
    .select("variant_id,status,last_synced_at").eq("channel", channel)
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
  const candidates = [...allCandidates].sort((a, b) => {
    const priority = rank(a) - rank(b);
    if (priority !== 0) return priority;
    const aTime = stateByVariant.get(a.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(a.id)?.last_synced_at)) : 0;
    const bTime = stateByVariant.get(b.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(b.id)?.last_synced_at)) : 0;
    return aTime - bTime;
  }).slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  const results: Array<{ variantId: string; ok: boolean; externalId?: string; error?: string }> = [];
  for (const candidate of candidates) {
    const product = candidate.commerce_products;
    const validOffers = asRelationRows(candidate.supplier_offers)
      .filter((x) => x.ship_to === "JP" && x.source_status === "verified" && x.tracking_supported === true && (x.supplier_code !== "cj" || (isCanonicalCjNativeId(x.supplier_product_id) && isCanonicalCjNativeId(x.supplier_variant_id))) && typeof x.last_checked_at === "string" && Date.parse(x.last_checked_at) <= Date.now() + 5 * 60_000 && Date.now() - Date.parse(x.last_checked_at) <= 24 * 60 * 60_000 && Number(x.inventory) > 0 && Number(x.unit_cost) >= 0 && Number(x.shipping_cost) >= 0);
    const validOfferIds = new Set(validOffers.map((x) => x.id));
    const price = asRelationRows(candidate.commerce_prices)
      .filter((x) => validOfferIds.has(x.supplier_offer_id) && x.currency === "JPY" && Number(x.selling_price) > 0 && Number(x.expected_profit) > 0)
      .sort((a, b) => Number(b.expected_profit) - Number(a.expected_profit))[0];
    const offer = price ? validOffers.find((x) => x.id === price.supplier_offer_id) : undefined;
    const imageUrl = safeUrl(product.image_url);
    if (!offer || !imageUrl || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0) {
      results.push({ variantId: candidate.id, ok: false, error: !offer ? "supplier_offer_missing_or_out_of_stock" : !imageUrl ? "image_url_invalid" : "price_not_profitable" });
      continue;
    }
    const title = candidate.title_ja.trim() || product.title_ja.trim();
    const storefrontStock = toStorefrontStockQuantity(offer.inventory, getStorefrontStockCap());
    if (!isJapaneseProductTitle(title)) {
      results.push({ variantId: candidate.id, ok: false, error: "japanese_product_title_invalid" });
      continue;
    }
    if (storefrontStock <= 0) {
      results.push({ variantId: candidate.id, ok: false, error: "storefront_stock_zero_after_cap" });
      continue;
    }
    const description = (product.description_ja || title + "。商品仕様・配送条件は仕入先の最新情報をご確認ください。").trim();
    const sku = "TRC-" + candidate.id.replace(/-/g, "").slice(0, 24).toUpperCase();
    let listingId: string | null = null;
    try {
      const { data: listing, error: listingError } = await db.from("channel_listings").upsert({
        variant_id: candidate.id, channel, selling_price: Math.round(Number(price.selling_price)),
        external_sku: sku, status: "pending", last_error: null, updated_at: new Date().toISOString()
      }, { onConflict: "channel,variant_id" }).select("id,external_product_id,external_variant_id").single();
      if (listingError || !listing) throw new Error("listing_claim_failed:" + (listingError?.message ?? "no_row"));
      listingId = String(listing.id);
      let externalProductId = listing.external_product_id ? String(listing.external_product_id) : null;
      let externalVariantId = listing.external_variant_id ? String(listing.external_variant_id) : null;
      let publishedUrl: string | null = null;
      if (channel === "base") {
        let baseResponse: unknown = null;
        const itemId = externalProductId;
        if (itemId) {
          baseResponse = await editBaseItem({ itemId, title, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          externalProductId = itemId;
        } else {
          const response = await createBaseItem({ title, identifier: sku, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          baseResponse = response;
          const returned = response.item?.item_id ?? response.item_id;
          externalProductId = String(returned ?? "");
          if (!externalProductId) throw new Error("base_item_id_missing");
          // Persist the external ID before image upload so retries edit this item instead of creating duplicates.
          const { error: saveCreatedIdError } = await db.from("channel_listings").update({
            external_product_id: externalProductId, external_sku: sku, status: "pending",
            last_error: null, updated_at: new Date().toISOString()
          }).eq("id", listing.id);
          if (saveCreatedIdError) throw new Error("base_created_item_id_save_failed:" + saveCreatedIdError.message);
        }
        await addBaseItemImage({ itemId: externalProductId, imageNo: 1, imageUrl });
        // Only make the item visible after the external ID and image are saved.
        const visibleResponse = await editBaseItem({ itemId: externalProductId, title, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: true });
        publishedUrl = resolveBasePublicUrl(visibleResponse, externalProductId, basePublicShopUrl)
          ?? resolveBasePublicUrl(baseResponse, externalProductId, basePublicShopUrl);
      } else {
        const handle = safeSlug(product.source_key + "-" + candidate.id.slice(0, 8));
        const productId = toShopifyGid("Product", externalProductId);
        const variantId = toShopifyGid("ProductVariant", externalVariantId);
        let recoveredProduct: { id: string; handle: string; variants: { nodes: Array<{ id: string; sku?: string | null }> } } | null = null;
        if (!productId || !variantId) {
          // Recover an external create whose response was lost before the DB ID was saved.
          const found = await shopifyGraphQL<{ products: { nodes: Array<{ id: string; handle: string; vendor?: string | null; tags?: string[]; variants: { nodes: Array<{ id: string; sku?: string | null }> } }> } }>(
            `query CommerceRecoverByHandle($query: String!) { products(first: 5, query: $query) { nodes { id handle vendor tags variants(first: 10) { nodes { id sku } } } } }`,
            { query: "handle:" + handle },
          );
          recoveredProduct = (found.products?.nodes ?? []).find((item) =>
            (item.vendor === "TRACER" || (item.tags ?? []).includes("TRACER")) &&
            (item.variants?.nodes ?? []).some((variant) => variant.sku === sku)
          ) ?? null;
        }
        const recoveredVariantId = recoveredProduct?.variants.nodes.find((variant) => variant.sku === sku)?.id ?? null;
        const productResult = productId && variantId
          ? await updateShopifyProduct({ productId, title, descriptionHtml: description, handle, price: Number(price.selling_price), variantId, sku, imageUrl: null })
          : recoveredProduct && recoveredVariantId
            ? await updateShopifyProduct({ productId: recoveredProduct.id, title, descriptionHtml: description, handle, price: Number(price.selling_price), variantId: recoveredVariantId, sku, imageUrl: null })
            : await createShopifyProduct({ title, descriptionHtml: description, handle, price: Number(price.selling_price), sku, imageUrl });
        externalProductId = productResult.id;
        const variant = productResult.variants?.nodes?.[0];
        if (!variant?.id) throw new Error("shopify_variant_id_missing");
        externalVariantId = variant.id;
        await setShopifyVariantInventory({ variantId: variant.id, quantity: storefrontStock, reference: "commerce-core:" + candidate.id });
        const publication = await ensureShopifyProductPublished(productResult.id);
        if (!publication.published) throw new Error("shopify_publication_not_confirmed");
        publishedUrl = "https://" + String(process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "") + "/products/" + productResult.handle;
      }
      const { error: finishError } = await db.from("channel_listings").update({
        external_product_id: externalProductId, external_variant_id: externalVariantId, external_sku: sku,
        status: "published", published_url: publishedUrl, last_error: null, last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", listing.id);
      if (finishError) throw new Error("listing_result_save_failed:" + finishError.message);
      results.push({ variantId: candidate.id, ok: true, externalId: externalProductId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { error: recordError } = await db.from("channel_listings").update({ status: "error", last_error: message.slice(0, 1500), last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("variant_id", candidate.id).eq("channel", channel);
      if (recordError) console.error("[commerce-publish] failed to record channel error", { variantId: candidate.id, channel, error: recordError.message });
      results.push({ variantId: candidate.id, ok: false, error: message.slice(0, 300) });
    }
  }
  return { channel, staleListings, considered: candidates.length, published: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length + staleListings.failed, results };
}
