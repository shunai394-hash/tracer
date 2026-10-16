import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cjSupplierAdapter } from "@/lib/procurement/cj-adapter";
import { addBaseItemImage, createBaseItem, editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, updateShopifyProduct } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

type Channel = "base" | "shopify";
type Candidate = {
  id: string; source_variant_key: string; title_ja: string; sku: string | null;
  commerce_products: { id: string; source_key: string; title_ja: string; description_ja: string; image_url: string | null; active: boolean };
  supplier_offers: Array<{ id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; supplier_url: string | null; currency: string; unit_cost: number; shipping_cost: number; inventory: number; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null }>;
  commerce_prices: { supplier_offer_id: string; currency: string; selling_price: number; expected_profit: number; fee_amount: number; margin_rate: number };
};

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function safeSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "tracer-item";
}

export async function syncCommerceListings(channel: Channel, limit = 10) {
  // Fail closed before any external storefront write until CJ live ordering/payment flow is proven.
  if (!cjSupplierAdapter.capabilities.liveOrdering) {
    return { channel, considered: 0, published: 0, failed: 1, results: [{ variantId: "", ok: false, error: "supplier_live_ordering_disabled_until_sandbox_payment_flow_proof" }] };
  }
  if (channel === "base" && !isBaseConfigured()) throw new Error("base_oauth_not_configured");
  if (channel === "shopify" && !isShopifyConfigured()) throw new Error("shopify_not_configured");
  const db = createSupabaseAdminClient();
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
    const offer = [...(candidate.supplier_offers ?? [])]
      .filter((x) => x.id === candidate.commerce_prices.supplier_offer_id && x.ship_to === "JP" && x.source_status === "verified" && x.tracking_supported === true && typeof x.last_checked_at === "string" && Date.parse(x.last_checked_at) <= Date.now() + 5 * 60_000 && Date.now() - Date.parse(x.last_checked_at) <= 24 * 60 * 60_000 && Number(x.inventory) > 0 && Number(x.unit_cost) >= 0 && Number(x.shipping_cost) >= 0)[0];
    const price = candidate.commerce_prices;
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
        const itemId = externalProductId;
        if (itemId) {
          await editBaseItem({ itemId, title, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          externalProductId = itemId;
        } else {
          const response = await createBaseItem({ title, identifier: sku, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: false });
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
        await editBaseItem({ itemId: externalProductId, title, detail: description, price: Number(price.selling_price), stock: storefrontStock, visible: true });
        publishedUrl = "https://thebase.com/";
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
  return { channel, considered: candidates.length, published: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}
