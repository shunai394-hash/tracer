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
  faire: boolean;
  dsersMcp: boolean;
  ecPulse: boolean;
  extension: boolean;
  base: boolean;
};

export function getFoundationStatus(): FoundationStatus {
  const supabase = getSupabasePublicConfig();

  return {
    supabasePublic: present(supabase.url) && present(supabase.anonKey),
    supabaseServiceRole: present(readEnv("SUPABASE_SERVICE_ROLE_KEY")),
    gemini: present(readEnv("GEMINI_API_KEY")),
    brightData: present(readEnv("BRIGHTDATA_API_TOKEN")),
    cj: present(readEnv("CJ_API_KEY")),
    brightDataMcp: present(readEnv("BRIGHTDATA_MCP_API_KEY")),
    shopify: present(readEnv("SHOPIFY_ACCESS_TOKEN")),
    metaAds: present(readEnv("META_ACCESS_TOKEN")),
    newfindInbound: (() => {
      const config = getNewfindConfig();
      return present(config.apiUrl) && present(config.webhookSecret);
    })(),
    newfindOutbound: (() => {
      const config = getNewfindConfig();
      return present(config.apiUrl) && present(config.apiKey);
    })(),
    stripe: present(readEnv("STRIPE_SECRET_KEY")),
    stripeWebhook: present(readEnv("STRIPE_WEBHOOK_SECRET")),
    orosy: present(getOrosyConfig().apiKey),
    faire: present(readEnv("FAIRE_ACCESS_TOKEN")),
    dsersMcp: present(readEnv("DSERS_MCP_URL")) && present(readEnv("DSERS_MCP_ACCESS_TOKEN")),
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

const DEFAULT_SUPABASE_URL = "https://lysavahpadzrhpounjgi.supabase.co";

export function getSupabasePublicConfig() {
  return {
    url: readEnv("NEXT_PUBLIC_SUPABASE_URL") || DEFAULT_SUPABASE_URL,
    anonKey:
      readEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ||
      readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

export function getSupabaseServiceRoleKey() {
  return readEnv("SUPABASE_SERVICE_ROLE_KEY");
}

export function getDsersMcpConfig() {
  return {
    endpoint: readEnv("DSERS_MCP_URL") || "https://ai.dsers.com/mcp",
    accessToken: readEnv("DSERS_MCP_ACCESS_TOKEN"),
  };
}

export function getFaireConfig() {
  return {
    accessToken: readEnv("FAIRE_ACCESS_TOKEN"),
    baseUrl: readEnv("FAIRE_API_BASE") || "https://www.faire.com/external-api/v2",
  };
}

export function getCJConfig() {
  return {
    apiKey: readEnv("CJ_API_KEY"),
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
    faire: present(readEnv("FAIRE_ACCESS_TOKEN")),
  };
}

export function isSupplierConfigured(supplierName: string): boolean {
  const name = supplierName.trim().toLowerCase();
  if (name === "cj" || name === "cjdropshipping") return present(readEnv("CJ_API_KEY"));
  if (name === "orosy") return present(getOrosyConfig().apiKey);
  if (name === "faire") return present(readEnv("FAIRE_ACCESS_TOKEN"));
  if (name === "dsers") return present(readEnv("DSERS_MCP_ACCESS_TOKEN"));
  return false;
}

export function isCJLiveOrderingEnabled(): boolean {
  return readEnv("CJ_LIVE_ORDERING") === "1";
}

export function isCJAutoOrderingEnabled(): boolean {
  return readEnv("CJ_AUTO_ORDERING") === "1";
}

export function isSupplierLiveOrderingEnabled(supplierName: string): boolean {
  const key = supplierName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").toUpperCase();
  if (key === "CJ" || key === "CJDROPSHIPPING") return isCJLiveOrderingEnabled();
  return readEnv(`${key}_LIVE_ORDERING`) === "1";
}

export function isSupplierAutoOrderingEnabled(supplierName: string): boolean {
  const key = supplierName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").toUpperCase();
  if (key === "CJ" || key === "CJDROPSHIPPING") return isCJAutoOrderingEnabled();
  return readEnv(`${key}_AUTO_ORDERING`) === "1";
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
