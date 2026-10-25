import "server-only";

import crypto from "node:crypto";
import { getShopifyConfig } from "@/lib/config/env";
import { resolveShopifyVariantIdentity } from "@/lib/shopify/variant-identity";

export type ShopifyProduct = {
  id: string;
  handle: string;
  status?: string | null;
  seo?: { title: string | null; description: string | null };
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

type ShopifyTokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string };

function safeShopifyErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const raw = [
    record.error_description,
    record.error,
    record.errors,
    record.message,
  ].find((value) => typeof value === "string" || Array.isArray(value));
  if (raw === undefined) return "";
  const textValue = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && "message" in entry) return String((entry as {message?: unknown}).message ?? "");
          return "";
        }).filter(Boolean).join("; ")
      : "";
  return textValue
    .replace(/(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]")
    .replace(/Bearer\\s+[^\\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/client_secret[=: ]+[^\\s,;]+/gi, "client_secret=[REDACTED]")
    .replace(/access_token[=: ]+[^\\s,;]+/gi, "access_token=[REDACTED]")
    .slice(0, 300);
}

let cachedShopifyAccessToken: string | null = null;
let cachedShopifyAccessTokenExpiresAt = 0;
let cachedShopifyCredentialFingerprint = "";

function clearCachedShopifyAccessToken(): void {
  cachedShopifyAccessToken = null;
  cachedShopifyAccessTokenExpiresAt = 0;
  cachedShopifyCredentialFingerprint = "";
}

async function getShopifyAccessToken(): Promise<string> {
  const { storeDomain, adminAccessToken, clientId, clientSecret } = getShopifyConfig();
  if (clientId && clientSecret) {
    const fingerprint = crypto.createHash("sha256")
      .update(`${storeDomain.trim()}\n${clientId}\n${clientSecret}`)
      .digest("hex");
    if (cachedShopifyCredentialFingerprint !== fingerprint) clearCachedShopifyAccessToken();
    if (cachedShopifyAccessToken && Date.now() < cachedShopifyAccessTokenExpiresAt) {
      return cachedShopifyAccessToken;
    }
    const domain = storeDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not configured");
    const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as ShopifyTokenResponse | null;
    if (!response.ok) {
      const detail = safeShopifyErrorDetail(payload);
      throw new Error(`Shopify OAuth token HTTP ${response.status}${detail ? ` detail=${detail}` : ""}`);
    }
    if (!payload?.access_token) throw new Error("Shopify OAuth token response missing access_token");
    const expiresIn = Number(payload.expires_in);
    const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_399;
    cachedShopifyAccessToken = payload.access_token;
    cachedShopifyAccessTokenExpiresAt = Date.now() + Math.max(30, ttlSeconds - 60) * 1000;
    cachedShopifyCredentialFingerprint = fingerprint;
    return cachedShopifyAccessToken;
  }
  if (adminAccessToken) return adminAccessToken;
  throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET is not configured");
}

/**
 * Shopify GraphQL needs global IDs. Some legacy shop_listings rows hold the
 * numeric REST id ("8593204641836"); used as-is they make product lookups
 * fail and unpublishing impossible. Normalise at the API boundary.
 */
export function toShopifyGid(kind: "Product" | "ProductVariant", id: string | null | undefined): string | null {
  const value = String(id ?? "").trim();
  if (!value) return null;
  if (value.startsWith("gid://shopify/")) return value;
  return /^\d+$/.test(value) ? `gid://shopify/${kind}/${value}` : value;
}

function resolveShopifyAuthMode(config: ReturnType<typeof getShopifyConfig>): "client_credentials" | "static_admin_token" {
  const requested = config.authMode;
  const hasClientCredentials = Boolean(config.clientId && config.clientSecret);
  const hasStaticToken = Boolean(config.adminAccessToken);

  if (requested === "client_credentials") {
    if (!hasClientCredentials) throw new Error("SHOPIFY_AUTH_MODE=client_credentials requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
    return requested;
  }
  if (requested === "static_admin_token") {
    if (!hasStaticToken) throw new Error("SHOPIFY_AUTH_MODE=static_admin_token requires SHOPIFY_ADMIN_ACCESS_TOKEN");
    return requested;
  }
  if (requested) throw new Error("SHOPIFY_AUTH_MODE must be client_credentials or static_admin_token");
  // Dev Dashboard credentials use Shopify client-credentials grant. When both
  // modern app credentials and a legacy static token exist, select the app flow
  // deterministically; never fall back to the static token if the exchange fails.
  if (hasClientCredentials && hasStaticToken) return "client_credentials";
  if (hasClientCredentials) return "client_credentials";
  if (hasStaticToken) return "static_admin_token";
  throw new Error("Shopify credentials are not configured");
}

export function isShopifyConfigured(): boolean {
  const config = getShopifyConfig();
  if (!config.storeDomain) return false;
  try {
    resolveShopifyAuthMode(config);
    return true;
  } catch {
    return false;
  }
}

async function getShopifyAccessTokenCandidates(): Promise<string[]> {
  const config = getShopifyConfig();
  const mode = resolveShopifyAuthMode(config);
  // One explicitly selected credential path per request. Never silently switch
  // to a different credential after an exchange or Admin API failure.
  if (mode === "client_credentials") {
    const token = (await getShopifyAccessToken()).trim();
    if (!token) throw new Error("Shopify client-credentials exchange returned an empty token");
    return [token];
  }
  const token = config.adminAccessToken.trim();
  if (!token || /\s/.test(token) || /^[\"']|[\"']$/.test(token)) {
    throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN is missing or malformed");
  }
  return [token];
}

async function shopifyAdminRequest(body: { query: string; variables?: Record<string, unknown> }): Promise<{ response: Response; token: string }> {
  const config = getShopifyConfig();
  const mode = resolveShopifyAuthMode(config);
  const candidates = await getShopifyAccessTokenCandidates();
  let lastTokenError: Error | null = null;

  for (let index = 0; index < candidates.length; index++) {
    let token = candidates[index].trim();
    if (!token || /\s/.test(token) || /^["']|["']$/.test(token)) {
      lastTokenError = new Error("Shopify access token is missing or malformed");
      continue;
    }

    let response = await fetch(shopifyEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    // On 401 only, discard a cached app token and retry the identical request
    // once with a freshly exchanged token. A 403 is an authorization/scope
    // failure, so it is reported without retrying or switching auth modes.
    if (response.status === 401 && mode === "client_credentials") {
      await response.body?.cancel().catch(() => undefined);
      clearCachedShopifyAccessToken();
      token = (await getShopifyAccessToken()).trim();
      if (!token || /\s/.test(token) || /^["']|["']$/.test(token)) {
        throw new Error("Fresh Shopify client-credentials token is missing or malformed");
      }
      response = await fetch(shopifyEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    }

    if ((response.status === 401 || response.status === 403) && index < candidates.length - 1) continue;
    return { response, token };
  }

  throw lastTokenError ?? new Error("No usable Shopify Admin API credential is configured");
}

export type ShopifyAuthProbeResult = {
  shopifyHttpStatus: number | null;
  shopifyRequestId: string | null;
  graphqlErrors: string[];
  shopId: string | null;
  ok: boolean;
};

/** Read-only auth probe. Never returns credentials or raw response bodies. */
export async function probeShopifyAuth(): Promise<ShopifyAuthProbeResult> {
  let response: Response;
  let responseText = "";
  let requestId: string | null = null;
  try {
    const result = await shopifyAdminRequest({ query: "query { shop { id } }" });
    response = result.response;
    requestId = response.headers.get("x-request-id");
    responseText = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shopify auth probe failed";
    const safeMessage = message.replace(/(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]").slice(0, 200);
    return { shopifyHttpStatus: null, shopifyRequestId: requestId, graphqlErrors: [safeMessage], shopId: null, ok: false };
  }

  let graphqlErrors: string[] = [];
  let shopId: string | null = null;
  try {
    const payload = JSON.parse(responseText) as { data?: { shop?: { id?: unknown } | null }; errors?: Array<{ message?: unknown }> };
    const secrets = [
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      process.env.SHOPIFY_CLIENT_SECRET,
      process.env.SHOPIFY_WEBHOOK_SECRET,
    ].filter((value): value is string => Boolean(value));
    graphqlErrors = Array.isArray(payload.errors)
      ? payload.errors.map((error) => {
          let message = String(error?.message ?? "GraphQL error");
          for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
          return message.replace(/(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]").slice(0, 300);
        })
      : [];
    const candidate = payload.data?.shop?.id;
    if (typeof candidate === "string" && candidate.trim()) shopId = candidate;
    if (response.ok && !shopId && graphqlErrors.length === 0) graphqlErrors.push("Shopify response did not include data.shop.id");
  } catch {
    graphqlErrors = ["Shopify returned a non-JSON response"];
  }

  return {
    shopifyHttpStatus: response.status,
    shopifyRequestId: requestId,
    graphqlErrors,
    shopId,
    ok: response.status === 200 && graphqlErrors.length === 0 && Boolean(shopId),
  };
}

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  throttleRetryAttempt = 0,
  httpReadRetryAttempt = 0,
): Promise<T> {
  // The configured auth mode is deterministic; auth failures never switch credentials.
  const { response, token } = await shopifyAdminRequest({ query, variables });

  const requestId = response.headers.get("x-request-id");
  const responseText = await response.text();

  // Never log the raw HTTP error body.
  if (!response.ok) {
    const diagnostic = {
      phase: "shopify_admin_request",
      status: response.status,
      requestId,
      time: new Date().toISOString(),
      deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    };

    console.error("Shopify Admin API request failed", diagnostic);

    // Never replay a mutation after a 5xx: Shopify may have committed it even if
    // the response failed. Only read-only queries can safely retry transient HTTP errors.
    const isReadOnlyQuery = query.trimStart().toLowerCase().startsWith("query");
    const retryableStatus = response.status === 429 || [500, 502, 503, 504].includes(response.status);
    if (isReadOnlyQuery && retryableStatus && httpReadRetryAttempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** httpReadRetryAttempt)));
      return shopifyGraphQL<T>(query, variables, throttleRetryAttempt, httpReadRetryAttempt + 1);
    }

    throw new Error(
      `Shopify Admin API HTTP ${response.status}; requestId=${requestId ?? "unknown"}`,
    );
  }

  let payload: GraphQLResponse<T>;
  try {
    payload = JSON.parse(responseText) as GraphQLResponse<T>;
  } catch {
    throw new Error("Shopify Admin API returned invalid JSON");
  }

  if (payload.errors?.some((error) => /throttled|throttle\s+limit/i.test(error.message)) && throttleRetryAttempt < 3) {
    // Shopify can return HTTP 200 with a GraphQL-level THROTTLED error.
    // Back off and retry only that transient condition; do not retry permission,
    // validation, or business-logic errors.
    await new Promise((resolve) => setTimeout(resolve, 500 * (throttleRetryAttempt + 1)));
    return shopifyGraphQL<T>(query, variables, throttleRetryAttempt + 1);
  }

  if (payload.errors?.length) {
    const secrets = [
      token,
      process.env.SHOPIFY_CLIENT_SECRET,
      process.env.SHOPIFY_WEBHOOK_SECRET,
    ].filter((value): value is string => Boolean(value));

    const messages = payload.errors.map((error) => {
      let message = error.message;
      for (const secret of secrets) {
        message = message.split(secret).join("[removed]");
      }
      return message.slice(0, 500);
    });

    throw new Error(messages.join("; "));
  }

  if (!payload.data) {
    throw new Error("Shopify Admin API returned no data");
  }

  return payload.data;
}


/** Read the scopes granted to this Shopify app installation. Never assume config presence implies permissions. */
export async function getShopifyGrantedScopes(): Promise<string[]> {
  const data = await shopifyGraphQL<{
    currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null;
  }>(`query TracerGrantedScopes { currentAppInstallation { accessScopes { handle } } }`);
  return [...new Set((data.currentAppInstallation?.accessScopes ?? [])
    .map((scope) => scope.handle.trim())
    .filter(Boolean))].sort();
}

export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  // Shopify app client secret is the HMAC secret for app webhooks unless an
  // explicit webhook-specific override has been configured.
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim() || process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(hmacHeader, "utf8");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

const TRACER_TAGS = ["TRACER"];

function shopifySeoInput(input: { title: string; descriptionHtml: string; seoTitle?: string | null; seoDescription?: string | null }): { title: string; description: string } {
  const plainDescription = input.descriptionHtml
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  const title = (input.seoTitle?.trim() || input.title.trim()).slice(0, 70).trim();
  const description = (input.seoDescription?.trim() || plainDescription || input.title.trim()).slice(0, 320).trim();
  if (!title || !description) throw new Error("shopify_seo_metadata_empty");
  return { title, description };
}

/** Confirm SEO metadata from a fresh persisted-product read, not the mutation payload. */
async function verifyPersistedShopifySeo(productId: string, productTitle: string, expected: { title: string; description: string }, phase: "create" | "update"): Promise<void> {
  const data = await shopifyGraphQL<{
    product: { title: string; seo: { title: string | null; description: string | null } | null } | null;
  }>(
    `query VerifyPersistedProductSeo($id: ID!) {
      product(id: $id) { title seo { title description } }
    }`,
    { id: productId },
  );
  const seo = data.product?.seo;
  // Shopify can return null for SEO title when it uses the product title as the default.
  // Treat that as equivalent only when the requested SEO title is exactly the product title.
  const titleMatches = seo?.title === expected.title || (seo?.title == null && expected.title === data.product?.title);
  if (!seo || !titleMatches || seo.description !== expected.description) {
    // Record bounded diagnostics so production logs reveal which persisted SEO
    // field differs. Do not weaken the exact comparison or mark the listing synced.
    const actualTitle = seo?.title ?? null;
    const actualDescription = seo?.description ?? null;
    const diagnostic = {
      phase,
      titleMatches,
      descriptionMatches: actualDescription === expected.description,
      expectedTitle: expected.title.slice(0, 120),
      productTitleInput: productTitle.slice(0, 120),
      actualTitle: actualTitle?.slice(0, 120) ?? null,
      expectedDescriptionLength: expected.description.length,
      actualDescriptionLength: actualDescription?.length ?? null,
      expectedDescriptionPrefix: expected.description.slice(0, 100),
      actualDescriptionPrefix: actualDescription?.slice(0, 100) ?? null,
    };
    throw new Error(`shopify_seo_readback_mismatch_after_${phase}:${JSON.stringify(diagnostic)}`);
  }
}


export async function createShopifyProduct(input: { title: string; descriptionHtml: string; handle: string; price: number; sku: string; imageUrl?: string | null; seoTitle?: string | null; seoDescription?: string | null }): Promise<ShopifyProduct> {
  const data = await shopifyGraphQL<{
    productCreate: { product: ShopifyProduct | null; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductCreate($input: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $input, media: $media) {
        product { id handle status seo { title description } variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType alt preview { image { url } } } } }
        userErrors { field message }
      }
    }`,
    { input: { title: input.title, descriptionHtml: input.descriptionHtml, handle: input.handle, seo: shopifySeoInput(input), status: "ACTIVE", vendor: "TRACER", productType: "TRACER Selection", tags: TRACER_TAGS }, media: input.imageUrl ? [{ originalSource: input.imageUrl, alt: input.title, mediaContentType: "IMAGE" }] : [] },
  );
  if (data.productCreate.userErrors.length) throw new Error(data.productCreate.userErrors.map((error) => error.message).join("; "));
  const product = data.productCreate.product;
  if (!product) throw new Error("Shopify productCreate returned no product");
  const expectedSeo = shopifySeoInput(input);
  await verifyPersistedShopifySeo(product.id, input.title, expectedSeo, "create");
  const variant = product.variants?.nodes?.[0];
  if (!variant) throw new Error("Shopify productCreate returned no variant");

  const variantData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string; sku: string | null; price: string | null }>; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price inventoryPolicy inventoryItem { tracked } }
        userErrors { field message }
      }
    }`,
    { productId: product.id, variants: [{ id: variant.id, price: input.price.toFixed(2), inventoryPolicy: "DENY", inventoryItem: { sku: input.sku, tracked: true } }] },
  );
  if (variantData.productVariantsBulkUpdate.userErrors.length) throw new Error(variantData.productVariantsBulkUpdate.userErrors.map((error) => error.message).join("; "));
  return { ...product, variants: { nodes: variantData.productVariantsBulkUpdate.productVariants } };
}

export async function updateShopifyProduct(input: { productId: string; title: string; descriptionHtml: string; handle: string; price: number; variantId?: string | null; sku: string; imageUrl?: string | null; seoTitle?: string | null; seoDescription?: string | null }): Promise<ShopifyProduct> {
  // Repair products that were previously created without media, while avoiding
  // adding another copy of the same image on every routine catalog sync.
  const existingMedia = await shopifyGraphQL<{
    product: { media: { nodes: Array<{ mediaContentType: string; preview?: { image?: { url: string } | null } | null }> } } | null;
  }>(
    "query TracerProductImagePreflight($id: ID!) { product(id: $id) { media(first: 10) { nodes { mediaContentType preview { image { url } } } } } }",
    { id: input.productId },
  );
  const hasProductImage = (existingMedia.product?.media.nodes ?? []).some((media) =>
    media.mediaContentType === "IMAGE" && Boolean(media.preview?.image?.url),
  );
  const mediaToAdd = !hasProductImage && input.imageUrl
    ? [{ originalSource: input.imageUrl, alt: input.title, mediaContentType: "IMAGE" }]
    : [];
  const productData = await shopifyGraphQL<{
    productUpdate: { product: ShopifyProduct | null; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductUpdate($input: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $input, media: $media) {
        product { id handle status seo { title description } variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType alt preview { image { url } } } } }
        userErrors { field message }
      }
    }`,
    { input: { id: input.productId, title: input.title, descriptionHtml: input.descriptionHtml, handle: input.handle, seo: shopifySeoInput(input), status: "ACTIVE", vendor: "TRACER", productType: "TRACER Selection", tags: TRACER_TAGS }, media: mediaToAdd },
  );
  if (productData.productUpdate.userErrors.length) throw new Error(productData.productUpdate.userErrors.map((error) => error.message).join("; "));
  const product = productData.productUpdate.product;
  if (!product) throw new Error("Shopify productUpdate returned no product");

  // Shopify processes externally hosted images asynchronously. A successful
  // productUpdate response can still have a null preview while media is
  // PROCESSING, so verify a fresh read before reporting the sync as successful.
  if (mediaToAdd.length > 0) {
    let imageReady = false;
    let imageFailed = false;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const mediaReadback = await shopifyGraphQL<{
        product: { media: { nodes: Array<{ mediaContentType: string; status?: string; image?: { url: string } | null }> } } | null;
      }>(
        `query VerifyUpdatedProductImage($id: ID!) {
          product(id: $id) {
            media(first: 10) {
              nodes {
                mediaContentType
                ... on MediaImage { status image { url } }
              }
            }
          }
        }`,
        { id: input.productId },
      );
      const images = (mediaReadback.product?.media.nodes ?? []).filter((media) => media.mediaContentType === "IMAGE");
      imageFailed = images.some((media) => media.status === "FAILED");
      imageReady = images.some((media) => media.status === "READY" && Boolean(media.image?.url));
      if (imageReady || imageFailed) break;
      if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    if (imageFailed) throw new Error("shopify_image_processing_failed");
    if (!imageReady) throw new Error("shopify_image_processing_not_ready_after_readback");
  }

  const expectedSeo = shopifySeoInput(input);
  await verifyPersistedShopifySeo(product.id, input.title, expectedSeo, "update");
  const variantResolution = resolveShopifyVariantIdentity(
    product.variants?.nodes ?? [],
    input.sku,
    toShopifyGid("ProductVariant", input.variantId),
  );
  if (!variantResolution.ok) throw new Error(`shopify_${variantResolution.reason}`);
  const variantId = variantResolution.variant.id;

  const variantData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string; sku: string | null; price: string | null }>; userErrors: Array<{ field?: string[]; message: string }> };
  }>(
    `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price inventoryPolicy inventoryItem { tracked } }
        userErrors { field message }
      }
    }`,
    { productId: input.productId, variants: [{ id: variantId, price: input.price.toFixed(2), inventoryPolicy: "DENY", inventoryItem: { sku: input.sku, tracked: true } }] },
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


async function setShopifyVariantInventoryAttempt(input: { variantId: string; quantity: number; reference?: string }, attempt = 0): Promise<void> {
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
  // The idempotency key must cover every input Shopify treats as part of this mutation.
  // currentAvailable changes after a successful write; omitting it reuses the same key
  // with different changeFromQuantity values on the next sync and triggers a conflict.
  const idempotencyKey = crypto.createHash("sha256").update(`${referenceDocumentUri}:${level.location.id}:${quantity}:${currentAvailable}`).digest("hex").slice(0, 64);

  let result: {
    inventorySetQuantities: {
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  };
  try {
    result = await shopifyGraphQL<{
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
  } catch (error) {
    // Shopify can return this optimistic-concurrency conflict as a top-level
    // GraphQL error rather than a mutation userError. Re-read before retrying.
    const message = error instanceof Error ? error.message : String(error);
    if (/changeFromQuantity argument no longer matches the persisted quantity/i.test(message) && attempt < 2) {
      return setShopifyVariantInventoryAttempt(input, attempt + 1);
    }
    throw error;
  }

  if (result.inventorySetQuantities.userErrors.length) {
    const message = result.inventorySetQuantities.userErrors.map((error) => error.message).join("; ");
    // Inventory can change between our read and inventorySetQuantities. Re-read
    // persisted quantity and retry only this optimistic-concurrency conflict;
    // all other Shopify errors still fail closed.
    if (/changeFromQuantity argument no longer matches the persisted quantity/i.test(message) && attempt < 2) {
      return setShopifyVariantInventoryAttempt(input, attempt + 1);
    }
    throw new Error(message);
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

export async function setShopifyVariantInventory(input: { variantId: string; quantity: number; reference?: string }): Promise<void> {
  return setShopifyVariantInventoryAttempt(input);
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
