import "server-only";

import crypto from "node:crypto";
import { getShopifyConfig } from "@/lib/config/env";

export type ShopifyProduct = {
  id: string;
  handle: string;
  status?: string | null;
  variants?: { nodes: Array<{ id: string; sku: string | null; price: string | null }> };
  media?: { nodes: Array<{ mediaContentType: string; alt: string | null; preview?: { image?: { url: string } | null } | null }> };
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

type ShopifyTokenResponse = { access_token?: string; expires_in?: number; error?: string };

let cachedShopifyAccessToken: string | null = null;
let cachedShopifyAccessTokenExpiresAt = 0;

async function getShopifyAccessToken(): Promise<string> {
  const { storeDomain, adminAccessToken, clientId, clientSecret } = getShopifyConfig();
  if (clientId && clientSecret) {
    if (cachedShopifyAccessToken && Date.now() < cachedShopifyAccessTokenExpiresAt) {
      return cachedShopifyAccessToken;
    }
    const domain = storeDomain.trim().replace(/^https?:\\/\\//, "").replace(/\\/$/, "");
    if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not configured");
    const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as ShopifyTokenResponse | null;
    if (!response.ok) throw new Error(`Shopify OAuth token HTTP ${response.status}${payload?.error ? `: ${payload.error}` : ""}`);
    if (!payload?.access_token) throw new Error("Shopify OAuth token response missing access_token");
    const expiresIn = Number(payload.expires_in);
    const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_399;
    cachedShopifyAccessToken = payload.access_token;
    cachedShopifyAccessTokenExpiresAt = Date.now() + Math.max(30, ttlSeconds - 60) * 1000;
    return cachedShopifyAccessToken;
  }
  if (adminAccessToken) return adminAccessToken;
  throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET is not configured");
}

export function isShopifyConfigured(): boolean {
  const { storeDomain, adminAccessToken, clientId, clientSecret } = getShopifyConfig();
  return Boolean(storeDomain && (adminAccessToken || (clientId && clientSecret)));
}

export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const accessToken = await getShopifyAccessToken();
  const response = await fetch(shopifyEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
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
        product { id handle status variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType alt preview { image { url } } } } }
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
        product { id handle status variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType alt preview { image { url } } } } }
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


export type ShopifyPublicationState = {
  publicationId: string;
  published: boolean;
};

export async function getOnlineStorePublicationId(): Promise<string> {
  const configured = process.env.SHOPIFY_PUBLICATION_ID?.trim();
  if (configured) return configured;

  const data = await shopifyGraphQL<{
    publications: { nodes: Array<{ id: string; name: string }> };
  }>(
    `query OnlineStorePublication {
      publications(first: 50) { nodes { id name } }
    }`,
  );
  const publication = data.publications.nodes.find((node) => node.name.trim().toLowerCase() === "online store");
  if (!publication) throw new Error("shopify_online_store_publication_not_found");
  return publication.id;
}

export async function ensureShopifyProductPublished(productId: string): Promise<ShopifyPublicationState> {
  const publicationId = await getOnlineStorePublicationId();
  const current = await shopifyGraphQL<{
    product: { publishedOnPublication: boolean } | null;
  }>(
    `query ProductPublicationCheck($id: ID!, $publicationId: ID!) {
      product(id: $id) { publishedOnPublication(publicationId: $publicationId) }
    }`,
    { id: productId, publicationId },
  );
  if (!current.product) throw new Error("shopify_product_not_found_for_publication_check");

  if (!current.product.publishedOnPublication) {
    const result = await shopifyGraphQL<{
      publishablePublish: {
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(
      `mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: productId, input: [{ publicationId }] },
    );
    if (result.publishablePublish.userErrors.length) {
      throw new Error(result.publishablePublish.userErrors.map((error) => error.message).join("; "));
    }
  }

  const verified = await shopifyGraphQL<{
    product: { publishedOnPublication: boolean } | null;
  }>(
    `query ProductPublicationVerify($id: ID!, $publicationId: ID!) {
      product(id: $id) { publishedOnPublication(publicationId: $publicationId) }
    }`,
    { id: productId, publicationId },
  );
  if (!verified.product?.publishedOnPublication) throw new Error("shopify_publication_verification_failed");
  return { publicationId, published: true };
}


export async function setShopifyVariantInventory(input: { variantId: string; quantity: number; reference?: string }): Promise<void> {
  const quantity = Math.max(0, Math.floor(input.quantity));
  const current = await shopifyGraphQL<{
    productVariant: {
      inventoryItem: {
        id: string;
        inventoryLevels: {
          nodes: Array<{
            location: { id: string; name: string };
            quantities: Array<{ name: string; quantity: number }>;
          }>;
        };
      };
    } | null;
  }>(
    `query VariantInventoryLevels($id: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          id
          inventoryLevels(first: 50) {
            nodes {
              location { id name }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }`,
    { id: input.variantId },
  );

  const variant = current.productVariant;
  if (!variant) throw new Error("shopify_variant_not_found_for_inventory_sync");
  const configuredLocation = process.env.SHOPIFY_INVENTORY_LOCATION_ID?.trim();
  const level = variant.inventoryItem.inventoryLevels.nodes.find((node) =>
    configuredLocation ? node.location.id === configuredLocation : true,
  );
  if (!level) throw new Error("shopify_inventory_location_not_found");

  const currentAvailable = level.quantities.find((q) => q.name === "available")?.quantity ?? 0;
  const referenceDocumentUri = input.reference?.trim() || `tracer://shopify-inventory-sync/${variant.inventoryItem.id}`;
  const idempotencyKey = crypto.createHash("sha256").update(`${referenceDocumentUri}:${level.location.id}:${quantity}`).digest("hex").slice(0, 64);

  const result = await shopifyGraphQL<{
    inventorySetQuantities: {
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(
    `mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri,
        quantities: [{
          inventoryItemId: variant.inventoryItem.id,
          locationId: level.location.id,
          quantity,
          changeFromQuantity: currentAvailable,
        }],
      },
      idempotencyKey,
    },
  );

  if (result.inventorySetQuantities.userErrors.length) {
    throw new Error(result.inventorySetQuantities.userErrors.map((error) => error.message).join("; "));
  }

  const verified = await shopifyGraphQL<{
    productVariant: {
      inventoryItem: {
        inventoryLevels: {
          nodes: Array<{
            location: { id: string };
            quantities: Array<{ name: string; quantity: number }>;
          }>;
        };
      };
    } | null;
  }>(
    `query VerifyVariantInventory($id: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          inventoryLevels(first: 50) {
            nodes {
              location { id }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }`,
    { id: input.variantId },
  );
  const verifiedLevel = verified.productVariant?.inventoryItem.inventoryLevels.nodes.find(
    (node) => node.location.id === level.location.id,
  );
  const verifiedQuantity = verifiedLevel?.quantities.find((q) => q.name === "available")?.quantity;
  if (verifiedQuantity !== quantity) {
    throw new Error(`shopify_inventory_verification_failed:expected=${quantity},actual=${verifiedQuantity ?? "missing"}`);
  }
}

export async function unpublishShopifyProduct(productId: string): Promise<ShopifyPublicationState> {
  const publicationId = await getOnlineStorePublicationId();
  const current = await shopifyGraphQL<{
    product: { publishedOnPublication: boolean } | null;
  }>(
    `query ProductPublicationCheck($id: ID!, $publicationId: ID!) {
      product(id: $id) { publishedOnPublication(publicationId: $publicationId) }
    }`,
    { id: productId, publicationId },
  );
  if (!current.product) throw new Error("shopify_product_not_found_for_unpublication_check");

  if (current.product.publishedOnPublication) {
    const result = await shopifyGraphQL<{
      publishableUnpublish: {
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(
      `mutation PublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: productId, input: [{ publicationId }] },
    );
    if (result.publishableUnpublish.userErrors.length) {
      throw new Error(result.publishableUnpublish.userErrors.map((error) => error.message).join("; "));
    }
  }

  const verified = await shopifyGraphQL<{
    product: { publishedOnPublication: boolean } | null;
  }>(
    `query ProductPublicationVerify($id: ID!, $publicationId: ID!) {
      product(id: $id) { publishedOnPublication(publicationId: $publicationId) }
    }`,
    { id: productId, publicationId },
  );
  if (verified.product?.publishedOnPublication) throw new Error("shopify_unpublication_verification_failed");
  return { publicationId, published: false };
}
