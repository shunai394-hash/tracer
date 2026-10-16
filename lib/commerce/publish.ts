import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { addBaseItemImage, createBaseItem, editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, updateShopifyProduct } from "@/lib/shopify/admin";

type Channel = "base" | "shopify";
type Candidate = {
  id: string; source_variant_key: string; title_ja: string; sku: string | null;
  commerce_products: { id: string; source_key: string; title_ja: string; description_ja: string; image_url: string | null; active: boolean };
  supplier_offers: Array<{ id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; supplier_url: string | null; currency: string; unit_cost: number; shipping_cost: number; inventory: number; ship_to: string; tracking_supported: boolean }>;
  commerce_prices: { currency: string; selling_price: number; expected_profit: number; fee_amount: number; margin_rate: number };
};

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function safeSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "tracer-item";
}

export async function syncCommerceListings(channel: Channel, limit = 10) {
  if (channel === "base" && !isBaseConfigured()) throw new Error("base_oauth_not_configured");
  if (channel === "shopify" && !isShopifyConfigured()) throw new Error("shopify_not_configured");
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("commerce_variants")
    .select("id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,supplier_url,currency,unit_cost,shipping_cost,inventory,ship_to,tracking_supported),commerce_prices!inner(currency,selling_price,expected_profit,fee_amount,margin_rate)")
    .eq("commerce_products.active", true).eq("supplier_offers.ship_to", "JP")
    .gt("supplier_offers.inventory", 0).eq("commerce_prices.currency", "JPY")
    .gt("commerce_prices.expected_profit", 0).order("updated_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, Math.floor(limit))));
  if (error) throw new Error("commerce_candidates_read_failed:" + error.message);
  const candidates = (data ?? []) as unknown as Candidate[];
  const results: Array<{ variantId: string; ok: boolean; externalId?: string; error?: string }> = [];
  for (const candidate of candidates) {
    const product = candidate.commerce_products;
    const offer = [...(candidate.supplier_offers ?? [])]
      .filter((x) => x.ship_to === "JP" && Number(x.inventory) > 0 && Number(x.unit_cost) >= 0 && Number(x.shipping_cost) >= 0)
      .sort((a, b) => Number(a.unit_cost) + Number(a.shipping_cost) - Number(b.unit_cost) - Number(b.shipping_cost))[0];
    const price = candidate.commerce_prices;
    const imageUrl = safeUrl(product.image_url);
    if (!offer || !imageUrl || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0) {
      results.push({ variantId: candidate.id, ok: false, error: !offer ? "supplier_offer_missing_or_out_of_stock" : !imageUrl ? "image_url_invalid" : "price_not_profitable" });
      continue;
    }
    const title = candidate.title_ja.trim() || product.title_ja.trim();
    const description = (product.description_ja || title + "。商品仕様・配送条件は仕入先の最新情報をご確認ください。").trim();
    const sku = "TRC-" + candidate.id.replace(/-/g, "").slice(0, 24).toUpperCase();
    try {
      const { data: listing, error: listingError } = await db.from("channel_listings").upsert({
        variant_id: candidate.id, channel, selling_price: Math.round(Number(price.selling_price)),
        external_sku: sku, status: "pending", last_error: null, updated_at: new Date().toISOString()
      }, { onConflict: "channel,variant_id" }).select("id,external_product_id,external_variant_id").single();
      if (listingError || !listing) throw new Error("listing_claim_failed:" + (listingError?.message ?? "no_row"));
      let externalProductId = listing.external_product_id ? String(listing.external_product_id) : null;
      let externalVariantId = listing.external_variant_id ? String(listing.external_variant_id) : null;
      let publishedUrl: string | null = null;
      if (channel === "base") {
        const itemId = externalProductId;
        const response = itemId
          ? await editBaseItem({ itemId, title, detail: description, price: Number(price.selling_price), stock: Number(offer.inventory), visible: true })
          : await createBaseItem({ title, identifier: sku, detail: description, price: Number(price.selling_price), stock: Number(offer.inventory), visible: true });
        const returned = response.item?.item_id ?? response.item_id;
        externalProductId = String(returned ?? itemId ?? "");
        if (!externalProductId) throw new Error("base_item_id_missing");
        if (!itemId) await addBaseItemImage({ itemId: externalProductId, imageNo: 1, imageUrl });
        publishedUrl = "https://thebase.com/";
      } else {
        const handle = safeSlug(product.source_key + "-" + candidate.id.slice(0, 8));
        const productId = toShopifyGid("Product", externalProductId);
        const variantId = toShopifyGid("ProductVariant", externalVariantId);
        const productResult = productId && variantId
          ? await updateShopifyProduct({ productId, title, descriptionHtml: description, handle, price: Number(price.selling_price), variantId, sku, imageUrl: null })
          : await createShopifyProduct({ title, descriptionHtml: description, handle, price: Number(price.selling_price), sku, imageUrl });
        externalProductId = productResult.id;
        const variant = productResult.variants?.nodes?.[0];
        if (!variant?.id) throw new Error("shopify_variant_id_missing");
        externalVariantId = variant.id;
        await setShopifyVariantInventory({ variantId: variant.id, quantity: Number(offer.inventory), reference: "commerce-core:" + candidate.id });
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
      await db.from("channel_listings").update({ status: "error", last_error: message.slice(0, 1500), last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", listing.id);
      results.push({ variantId: candidate.id, ok: false, error: message.slice(0, 300) });
    }
  }
  return { channel, considered: candidates.length, published: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}
