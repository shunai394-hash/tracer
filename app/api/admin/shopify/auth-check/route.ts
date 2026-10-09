import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getShopifyConfig } from "@/lib/config/env";
import { probeShopifyAuth, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Admin API access scopes the code actually needs, derived from the GraphQL
// operations in lib/shopify (products/variants, inventory + locations,
// publications, orders, fulfillment orders + fulfillments).
const REQUIRED_SCOPES: Array<{ scope: string; satisfiedBy: string[]; usedBy: string }> = [
  { scope: "write_products", satisfiedBy: ["write_products"], usedBy: "productCreate/productUpdate/productVariantsBulkUpdate" },
  { scope: "read_products", satisfiedBy: ["read_products", "write_products"], usedBy: "products/product/nodes(ProductVariant)" },
  { scope: "write_inventory", satisfiedBy: ["write_inventory"], usedBy: "inventorySetQuantities" },
  { scope: "read_inventory", satisfiedBy: ["read_inventory", "write_inventory"], usedBy: "inventoryLevels/inventoryQuantity" },
  { scope: "read_locations", satisfiedBy: ["read_locations"], usedBy: "inventoryLevels.location" },
  { scope: "write_publications", satisfiedBy: ["write_publications"], usedBy: "publishablePublish/publishableUnpublish" },
  { scope: "read_publications", satisfiedBy: ["read_publications", "write_publications"], usedBy: "publications/publishedOnPublication" },
  { scope: "read_orders", satisfiedBy: ["read_orders", "write_orders"], usedBy: "orders(PaidOrders)/order" },
  { scope: "read_merchant_managed_fulfillment_orders", satisfiedBy: ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"], usedBy: "order.fulfillmentOrders" },
  { scope: "write_merchant_managed_fulfillment_orders", satisfiedBy: ["write_merchant_managed_fulfillment_orders"], usedBy: "fulfillmentCreate" },
];

function host(domain: string): string {
  return domain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Read-only Shopify authentication diagnosis. Never returns credential
 * values: only which variables are present, token-exchange / Admin API HTTP
 * status, the granted access scopes and DB error counts.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const cfg = getShopifyConfig();
  const domain = host(cfg.storeDomain ?? "");
  const config = {
    storeDomain: domain || null,
    storeDomainIsMyshopify: /\.myshopify\.com$/i.test(domain),
    apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || "2026-07 (default)",
    adminAccessTokenPresent: Boolean(cfg.adminAccessToken),
    adminAccessTokenPrefix: cfg.adminAccessToken ? (cfg.adminAccessToken.match(/^(shpat|shpca|shppa|shpss|shpua)_/i)?.[1]?.toLowerCase() ?? "other") : null,
    clientIdPresent: Boolean(cfg.clientId),
    clientSecretPresent: Boolean(cfg.clientSecret),
    authMode: cfg.clientId && cfg.clientSecret ? "client_credentials" : cfg.adminAccessToken ? "static_admin_token" : "none",
    vercelEnv: process.env.VERCEL_ENV ?? null,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };

  // 1) Token exchange (client credentials only), status only.
  let tokenExchange: Record<string, unknown> = { attempted: false };
  if (config.authMode === "client_credentials" && domain) {
    try {
      const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      tokenExchange = {
        attempted: true,
        httpStatus: response.status,
        ok: response.ok && typeof payload?.access_token === "string",
        tokenReturned: typeof payload?.access_token === "string",
        grantedScopeHandles: typeof payload?.scope === "string" ? String(payload.scope).split(",").map((s) => s.trim()).filter(Boolean) : null,
        expiresIn: typeof payload?.expires_in === "number" ? payload.expires_in : null,
        error: typeof payload?.error === "string" ? payload.error : null,
      };
    } catch (error) {
      tokenExchange = { attempted: true, ok: false, networkError: error instanceof Error ? error.message.slice(0, 200) : String(error) };
    }
  }

  // 2) Exact read-only authentication probe. Its status is the Shopify HTTP status,
  // not the outer diagnostic endpoint status. No raw response body or credentials are returned.
  const shopifyProbe = await probeShopifyAuth();

  // 3) Read-only Admin API call for app identity and granted scopes.
  let adminApi: Record<string, unknown>;
  try {
    const data = await shopifyGraphQL<{
      shop: { name: string; myshopifyDomain: string; plan: { displayName: string | null } | null };
      currentAppInstallation: { app: { title: string; handle: string | null } | null; accessScopes: Array<{ handle: string }> } | null;
    }>(`query TracerShopifyAuthCheck {
      shop { name myshopifyDomain plan { displayName } }
      currentAppInstallation { app { title handle } accessScopes { handle } }
    }`);
    const granted = new Set((data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
    adminApi = {
      ok: true,
      shop: data.shop,
      app: data.currentAppInstallation?.app ?? null,
      grantedScopes: [...granted].sort(),
      requiredScopes: REQUIRED_SCOPES.map((r) => ({ ...r, granted: r.satisfiedBy.some((s) => granted.has(s)) })),
      missingScopes: REQUIRED_SCOPES.filter((r) => !r.satisfiedBy.some((s) => granted.has(s))).map((r) => r.scope),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    adminApi = { ok: false, error: message.slice(0, 400), httpStatus: Number(message.match(/HTTP (\d{3})/)?.[1] ?? 0) || null };
  }

  // 4) DB state (counts only).
  const db = createSupabaseAdminClient();
  const count = async (build: (q: ReturnType<ReturnType<typeof db.from>["select"]>) => ReturnType<ReturnType<typeof db.from>["select"]>) => {
    const { count: n, error } = await build(db.from("shop_listings").select("id", { count: "exact", head: true }));
    return error ? `error: ${error.message}` : n ?? 0;
  };
  const [listings, published, linked, synced, failed, http401, preflight401] = await Promise.all([
    count((q) => q),
    count((q) => q.eq("published", true)),
    count((q) => q.not("shopify_product_id", "is", null)),
    count((q) => q.eq("shopify_sync_status", "synced")),
    count((q) => q.eq("shopify_sync_status", "failed")),
    count((q) => q.ilike("shopify_sync_error", "%HTTP 401%")),
    count((q) => q.ilike("shopify_sync_error", "%preflight%401%")),
  ]);
  const { data: lastErrors } = await db
    .from("shop_listings")
    .select("shopify_sync_error, shopify_synced_at")
    .ilike("shopify_sync_error", "%HTTP 401%")
    .order("shopify_synced_at", { ascending: false, nullsFirst: false })
    .limit(3);

  return NextResponse.json({
    ok: shopifyProbe.ok,
    shopifyHttpStatus: shopifyProbe.shopifyHttpStatus,
    shopifyRequestId: shopifyProbe.shopifyRequestId,
    graphqlErrors: shopifyProbe.graphqlErrors,
    shopId: shopifyProbe.shopId,
    generatedAt: new Date().toISOString(),
    config,
    tokenExchange,
    adminApi,
    db: {
      shopListings: listings,
      published,
      shopifyLinked: linked,
      shopifySynced: synced,
      shopifySyncFailed: failed,
      shopifyHttp401Rows: http401,
      preflight401Rows: preflight401,
      latest401: (lastErrors ?? []).map((row) => ({ at: row.shopify_synced_at, error: String(row.shopify_sync_error ?? "").slice(0, 200) })),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
