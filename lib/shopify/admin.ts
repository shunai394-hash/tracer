import "server-only";

import crypto from "node:crypto";
import { getShopifyConfig } from "@/lib/config/env";

export type ShopifyProduct = {
  id: string;
  handle: string;
  status?: string | null;
  variants?: { nodes: Array<{ id: string; sku: string | null; price: string | null }> };
};

type GraphQLError = { message: string };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };

function shopifyEndpoint(): string {
  const { storeDomain } = getShopifyConfig();
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || "2026-07";
  const domain = storeDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not configured");
  return `https://${domain}/admin/api/${apiVersion}/graphql.json`;
}

export function isShopifyConfigured(): boolean {
  const { storeDomain, adminAccessToken } = getShopifyConfig();
  return Boolean(storeDomain && adminAccessToken);
}

export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { adminAccessToken } = getShopifyConfig();
  if (!adminAccessToken) throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN is not configured");
  const response = await fetch(shopifyEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": adminAccessToken },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const payload = (await response.json()) as GraphQLResponse<T>;
  if (!response.ok) throw new Error(`Shopify Admin API HTTP ${response.status}`);
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
  if (!payload.data) throw new Error("Shopify Admin API returned no data");
  return payload.data;
}

export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(hmacHeader, "utf8");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

const TRACER_TAGS = ["TRACER", "tracer-sales-test-gate"];

export async function createShopifyProduct(input: { title: string; descriptionHtml: string; handle: string; price: number; sku: string; imageUrl?: string | null }): Promise<ShopifyProduct> {
  const data = await shopifyGraphQL<{
    productCreate: { product: ShopifyProduct | null; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $input, media: $media) {
        product { id handle status variants(first: 10) { nodes { id sku price } } }
        userErrors { field message }
      }
    }`,
    { input: { title: input.title, descriptionHtml: input.descriptionHtml, handle: input.handle, status: "ACTIVE", vendor: "TRACER", productType: "TRACER Selection", tags: TRACER_TAGS }, media: input.imageUrl ? [{ originalSource: input.imageUrl, alt: input.title, mediaContentType: "IMAGE" }] : [] },
  );
  if (data.productCreate.userErrors.length) throw new Error(data.productCreate.userErrors.map((error) => error.message).join("; "));
  const product = data.productCreate.product;
  if (!product) throw new Error("Shopify productCreate returned no product");
  const variant = product.variants?.nodes?.[0];
  if (!variant) throw new Error("Shopify productCreate returned no variant");

  const variantData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string; sku: string | null; price: string | null }>; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price }
        userErrors { field message }
      }
    }`,
    { productId: product.id, variants: [{ id: variant.id, price: input.price.toFixed(2), sku: input.sku }] },
  );
  if (variantData.productVariantsBulkUpdate.userErrors.length) throw new Error(variantData.productVariantsBulkUpdate.userErrors.map((error) => error.message).join("; "));
  return { ...product, variants: { nodes: variantData.productVariantsBulkUpdate.productVariants } };
}

export async function updateShopifyProduct(input: { productId: string; title: string; descriptionHtml: string; handle: string; price: number; variantId?: string | null; sku: string; imageUrl?: string | null }): Promise<ShopifyProduct> {
  const productData = await shopifyGraphQL<{
    productUpdate: { product: ShopifyProduct | null; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductUpdate($input: ProductInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $input, media: $media) {
        product { id handle status variants(first: 10) { nodes { id sku price } } }
        userErrors { field message }
      }
    }`,
    { input: { id: input.productId, title: input.title, descriptionHtml: input.descriptionHtml, handle: input.handle, status: "ACTIVE", vendor: "TRACER", productType: "TRACER Selection", tags: TRACER_TAGS }, media: input.imageUrl ? [{ originalSource: input.imageUrl, alt: input.title, mediaContentType: "IMAGE" }] : [] },
  );
  if (productData.productUpdate.userErrors.length) throw new Error(productData.productUpdate.userErrors.map((error) => error.message).join("; "));
  const product = productData.productUpdate.product;
  if (!product) throw new Error("Shopify productUpdate returned no product");
  const variantId = input.variantId ?? product.variants?.nodes?.[0]?.id;
  if (!variantId) throw new Error("Shopify product has no variant");

  const variantData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string; sku: string | null; price: string | null }>; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price }
        userErrors { field message }
      }
    }`,
    { productId: input.productId, variants: [{ id: variantId, price: input.price.toFixed(2), sku: input.sku }] },
  );
  if (variantData.productVariantsBulkUpdate.userErrors.length) throw new Error(variantData.productVariantsBulkUpdate.userErrors.map((error) => error.message).join("; "));
  return { ...product, variants: { nodes: variantData.productVariantsBulkUpdate.productVariants } };
}
