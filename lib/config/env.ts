import "server-only";

function present(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export type FoundationStatus = {
  supabasePublic: boolean;
  supabaseServiceRole: boolean;
  gemini: boolean;
  brightData: boolean;
  cj: boolean;
  brightDataMcp: boolean;
  shopify: boolean;
  metaAds: boolean;
  newfindInbound: boolean;
  newfindOutbound: boolean;
  stripe: boolean;
  stripeWebhook: boolean;
  orosy: boolean;
  ecPulse: boolean;
  extension: boolean;
  base: boolean;
};

export function getFoundationStatus(): FoundationStatus {
  return {
    supabasePublic: present(readEnv("NEXT_PUBLIC_SUPABASE_URL")) &&
      (present(readEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")) ||
        present(readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))),
    supabaseServiceRole: present(readEnv("SUPABASE_SERVICE_ROLE_KEY")),
    gemini: present(readEnv("GEMINI_API_KEY")),
    brightData: present(readEnv("BRIGHTDATA_API_TOKEN")),
    cj: present(readEnv("CJ_API_KEY")),
    brightDataMcp: present(readEnv("BRIGHTDATA_MCP_API_KEY")),
    shopify: present(readEnv("SHOPIFY_ACCESS_TOKEN")),
    metaAds: present(readEnv("META_ACCESS_TOKEN")),
    newfindInbound: present(readEnv("NEWFind_INBOUND_URL")) ||
      present(readEnv("NEWFind_INBOUND_API_URL")),
    newfindOutbound: present(readEnv("NEWFind_OUTBOUND_URL")) ||
      present(readEnv("NEWFind_OUTBOUND_API_URL")),
    stripe: present(readEnv("STRIPE_SECRET_KEY")),
    stripeWebhook: present(readEnv("STRIPE_WEBHOOK_SECRET")),
    orosy: present(readEnv("OROSY_API_KEY")),
    ecPulse: present(readEnv("EC_PULSE_API_KEY")),
    extension: present(readEnv("TRACER_EXTENSION_API_KEY")),
    base: present(readEnv("BASE_ACCESS_TOKEN")) ||
      present(readEnv("BASE_REFRESH_TOKEN")),
  };
}

export function getGeminiConfig() {
  const apiKey = readEnv("GEMINI_API_KEY");
  const model = readEnv("GEMINI_MODEL") || "gemini-2.5-flash";
  return { apiKey, model };
}

export function getBrightDataConfig() {
  return {
    apiToken: readEnv("BRIGHTDATA_API_TOKEN"),
    zone: readEnv("BRIGHTDATA_ZONE"),
    mcpUrl: readEnv("BRIGHTDATA_MCP_URL"),
  };
}

export function getSupabasePublicConfig() {
  return {
    url: readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    anonKey:
      readEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ||
      readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

export function getSupabaseServiceRoleKey() {
  return readEnv("SUPABASE_SERVICE_ROLE_KEY");
}

export function getCJConfig() {
  return {
    apiKey: readEnv("CJ_API_KEY"),
  };
}

export function getCJOrderConfig() {
  return {
    logisticName: readEnv("CJ_LOGISTIC_NAME"),
    fromCountryCode: readEnv("CJ_FROM_COUNTRY_CODE"),
    shippingCountry: readEnv("CJ_SHIPPING_COUNTRY"),
  };
}

export function getECPulseConfig() {
  return {
    apiUrl: readEnv("EC_PULSE_API_URL"),
    apiKey: readEnv("EC_PULSE_API_KEY"),
  };
}

export function getExtensionConfig() {
  return {
    apiKey: readEnv("TRACER_EXTENSION_API_KEY"),
  };
}

export function getDropshipSupplierConfig() {
  return {
    cj: present(readEnv("CJ_API_KEY")),
    hypersku: present(readEnv("HYPERSKU_API_KEY")),
    dsers: present(readEnv("DSERS_API_KEY")),
    zendrop: present(readEnv("ZENDROP_API_KEY")),
    syncee: present(readEnv("SYNCEE_API_KEY")),
    orosy: present(readEnv("OROSY_API_KEY")) || present(readEnv("OROSY_DEMO_API_KEY")),
  };
}

export function isCJLiveOrderingEnabled(): boolean {
  return readEnv("CJ_LIVE_ORDERING") === "1";
}

export function isCJAutoOrderingEnabled(): boolean {
  return readEnv("CJ_AUTO_ORDERING") === "1";
}

export type OrosyEnvironment = "demo" | "live";

export function getOrosyEnvironment(): OrosyEnvironment {
  return readEnv("OROSY_ENVIRONMENT") === "live" ? "live" : "demo";
}

export function getOrosyConfig() {
  const environment = getOrosyEnvironment();
  const apiKey =
    environment === "live"
      ? readEnv("OROSY_API_KEY")
      : readEnv("OROSY_DEMO_API_KEY");

  return {
    apiKey,
    environment,
    baseUrl: readEnv("OROSY_API_BASE_URL") || "https://wholesale-api.orosy.com/v1",
  };
}

export function isOrosyLiveOrderingEnabled(): boolean {
  return readEnv("OROSY_LIVE_ORDERING") === "1";
}

export function isTeacherWeightApplyEnabled(): boolean {
  return readEnv("TEACHER_APPLY_WEIGHTS") === "1";
}

export function getShopifyConfig() {
  return {
    storeDomain: readEnv("SHOPIFY_STORE_DOMAIN"),
    adminAccessToken: readEnv("SHOPIFY_ADMIN_ACCESS_TOKEN"),
    apiVersion: readEnv("SHOPIFY_API_VERSION") || "2024-10",
  };
}

export function getMetaAdsConfig() {
  return {
    accessToken: readEnv("META_ACCESS_TOKEN"),
    adAccountId: readEnv("META_AD_ACCOUNT_ID"),
    apiVersion: readEnv("META_API_VERSION") || "v21.0",
  };
}

export function getStripeConfig() {
  return {
    secretKey: readEnv("STRIPE_SECRET_KEY"),
    webhookSecret: readEnv("STRIPE_WEBHOOK_SECRET"),
    siteUrl: readEnv("NEXT_PUBLIC_SITE_URL"),
  };
}

export function getOrosyWarehouseShipTo(): {
  name: string;
  postal_code: string;
  prefecture: string;
  city: string;
  address_line1: string;
  phone: string;
} | null {
  const name = readEnv("OROSY_WAREHOUSE_NAME");
  const postalCode = readEnv("OROSY_WAREHOUSE_POSTAL_CODE");
  const prefecture = readEnv("OROSY_WAREHOUSE_PREFECTURE");
  const city = readEnv("OROSY_WAREHOUSE_CITY");
  const addressLine1 = readEnv("OROSY_WAREHOUSE_ADDRESS_LINE1");
  const phone = readEnv("OROSY_WAREHOUSE_PHONE");

  if (!name || !postalCode || !prefecture || !city || !addressLine1 || !phone) {
    return null;
  }

  return { name, postal_code: postalCode, prefecture, city, address_line1: addressLine1, phone };
}

export function getNewfindConfig() {
  return {
    webhookSecret: readEnv("NEWFIND_WEBHOOK_SECRET"),
    apiUrl: readEnv("NEWFIND_API_URL"),
    apiKey: readEnv("NEWFIND_API_KEY"),
  };
}

export function isSupplierDryRunEnabled(): boolean {
  return readEnv("SUPPLIER_DRY_RUN") !== "0";
}
