import "server-only";

function present(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

export type FoundationStatus = {
  supabasePublic: boolean;
  supabaseServiceRole: boolean;
  gemini: boolean;
  brightData: boolean;
  brightDataMcp: boolean;
  shopify: boolean;
  metaAds: boolean;
  newfindInbound: boolean;
  newfindOutbound: boolean;
  stripe: boolean;
  stripeWebhook: boolean;
  orosy: boolean;
};

export function getFoundationStatus(): FoundationStatus {
  return {
    supabasePublic: present(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRole: present(process.env.SUPABASE_SERVICE_ROLE_KEY),
    gemini: present(process.env.GEMINI_API_KEY),
    brightData: present(process.env.BRIGHTDATA_API_TOKEN),
    brightDataMcp: present(process.env.BRIGHTDATA_MCP_URL),
    shopify: present(process.env.SHOPIFY_STORE_DOMAIN) &&
      present(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN),
    metaAds: present(process.env.META_ACCESS_TOKEN) &&
      present(process.env.META_AD_ACCOUNT_ID),
    newfindInbound: present(process.env.NEWFIND_WEBHOOK_SECRET),
    newfindOutbound: present(process.env.NEWFIND_API_URL) &&
      present(process.env.NEWFIND_API_KEY),
    stripe: present(process.env.STRIPE_SECRET_KEY),
    stripeWebhook: present(process.env.STRIPE_WEBHOOK_SECRET),
    orosy: present(process.env.OROSY_API_KEY) || present(process.env.OROSY_DEMO_API_KEY),
  };
}

export function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  return { apiKey, model };
}

export function getBrightDataConfig() {
  return {
    apiToken: process.env.BRIGHTDATA_API_TOKEN?.trim() ?? "",
    zone: process.env.BRIGHTDATA_ZONE?.trim() ?? "",
    mcpUrl: process.env.BRIGHTDATA_MCP_URL?.trim() ?? "",
  };
}

export function getSupabasePublicConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
  };
}

export function getSupabaseServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
}

export function getCJConfig() {
  return {
    apiKey: process.env.CJ_API_KEY?.trim() ?? "",
  };
}

export function getDropshipSupplierConfig() {
  return {
    cj: present(process.env.CJ_API_KEY),
    hypersku: present(process.env.HYPERSKU_API_KEY),
    dsers: present(process.env.DSERS_API_KEY),
    zendrop: present(process.env.ZENDROP_API_KEY),
    syncee: present(process.env.SYNCEE_API_KEY),
    orosy: present(process.env.OROSY_API_KEY) || present(process.env.OROSY_DEMO_API_KEY),
  };
}

/**
 * CJ real order execution is off unless explicitly turned on. This is the single
 * switch that separates "recorded purchase order" from "actual supplier.createOrderV2 call".
 */
export function isCJLiveOrderingEnabled(): boolean {
  return process.env.CJ_LIVE_ORDERING?.trim() === "1";
}

export type OrosyEnvironment = "demo" | "live";

/**
 * "demo"/"live" is an explicit TRACER-side setting, never inferred from the
 * key's own naming (a key's prefix is not a reliable contract). Defaults to
 * "demo" — the safer assumption — so a missing/misconfigured value never
 * silently unlocks live-mode behavior (e.g. it keeps /simulate reachable,
 * which orosy documents as demo-only).
 */
export function getOrosyEnvironment(): OrosyEnvironment {
  return process.env.OROSY_ENVIRONMENT?.trim() === "live" ? "live" : "demo";
}

export function getOrosyConfig() {
  const environment = getOrosyEnvironment();
  // No cross-fallback between the two keys: which key gets used must be an
  // explicit, independent decision per environment. Falling back to
  // OROSY_API_KEY while "demo" would mean a key later rotated to a genuine
  // production credential gets silently treated as safe-to-simulate-against
  // the moment OROSY_DEMO_API_KEY is unset — exactly the ambiguity
  // OROSY_ENVIRONMENT exists to remove.
  const apiKey =
    environment === "live"
      ? process.env.OROSY_API_KEY?.trim() ?? ""
      : process.env.OROSY_DEMO_API_KEY?.trim() ?? "";

  return {
    apiKey,
    environment,
    baseUrl: process.env.OROSY_API_BASE_URL?.trim() || "https://wholesale-api.orosy.com/v1",
  };
}

/**
 * Mirrors CJ_LIVE_ORDERING: real order execution (POST /v1/orders actually
 * firing) is off unless explicitly turned on, regardless of OROSY_ENVIRONMENT.
 */
export function isOrosyLiveOrderingEnabled(): boolean {
  return process.env.OROSY_LIVE_ORDERING?.trim() === "1";
}

export function isTeacherWeightApplyEnabled(): boolean {
  return process.env.TEACHER_APPLY_WEIGHTS?.trim() === "1";
}

export function getShopifyConfig() {
  return {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN?.trim() ?? "",
    adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim() ?? "",
    apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || "2024-10",
  };
}

export function getMetaAdsConfig() {
  return {
    accessToken: process.env.META_ACCESS_TOKEN?.trim() ?? "",
    adAccountId: process.env.META_AD_ACCOUNT_ID?.trim() ?? "",
    apiVersion: process.env.META_API_VERSION?.trim() || "v21.0",
  };
}

export function getStripeConfig() {
  return {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? "",
  };
}

/**
 * The ship-to address for orosy wholesale/procurement orders — TRACER's own
 * warehouse, not a customer's address. Returns null (not a guessed/partial
 * address) unless every field is actually configured.
 */
export function getOrosyWarehouseShipTo(): {
  name: string;
  postal_code: string;
  prefecture: string;
  city: string;
  address_line1: string;
  phone: string;
} | null {
  const name = process.env.OROSY_WAREHOUSE_NAME?.trim();
  const postalCode = process.env.OROSY_WAREHOUSE_POSTAL_CODE?.trim();
  const prefecture = process.env.OROSY_WAREHOUSE_PREFECTURE?.trim();
  const city = process.env.OROSY_WAREHOUSE_CITY?.trim();
  const addressLine1 = process.env.OROSY_WAREHOUSE_ADDRESS_LINE1?.trim();
  const phone = process.env.OROSY_WAREHOUSE_PHONE?.trim();

  if (!name || !postalCode || !prefecture || !city || !addressLine1 || !phone) {
    return null;
  }

  return { name, postal_code: postalCode, prefecture, city, address_line1: addressLine1, phone };
}

export function getNewfindConfig() {
  return {
    webhookSecret: process.env.NEWFIND_WEBHOOK_SECRET?.trim() ?? "",
    apiUrl: process.env.NEWFIND_API_URL?.trim() ?? "",
    apiKey: process.env.NEWFIND_API_KEY?.trim() ?? "",
  };
}
