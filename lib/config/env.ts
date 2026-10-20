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
  brightDataMcp: boolean;
  shopify: boolean;
  metaAds: boolean;
  newfindInbound: boolean;
  newfindOutbound: boolean;
  stripe: boolean;
  stripeWebhook: boolean;
  faire: boolean;
  dsersMcp: boolean;
  printful: boolean;
  ecPulse: boolean;
  extension: boolean;
  base: boolean;
};

export function getCJConfig() {
  return {
    apiKey: readEnv("CJ_API_KEY"),
  };
}

export function isCJLiveOrderingEnabled(): boolean {
  return readEnv("CJ_LIVE_ORDERING") === "1";
}

export function isCJAutoOrderingEnabled(): boolean {
  return readEnv("CJ_AUTO_ORDERING") === "1";
}

/**
 * A supplier listing may be marked orderable only when production explicitly
 * enabled the live CJ path, the sandbox lifecycle proof is recorded, and dry
 * run is disabled. Each listing still needs fresh exact-variant stock and JP
 * freight checks before this capability is persisted on the row.
 */
export function isCJLiveOrderPathReady(): boolean {
  return present(getCJConfig().apiKey)
    && isCJLiveOrderingEnabled()
    && isCJAutoOrderingEnabled()
    && readEnv("CJ_PAYMENT_FLOW_VERIFIED") === "1"
    && !isSupplierDryRunEnabled();
}

export function getNewfindConfig() {
  return {
    webhookSecret: readEnv("NEWFIND_WEBHOOK_SECRET"),
    apiUrl: readEnv("NEWFIND_API_URL"),
    apiKey: readEnv("NEWFIND_API_KEY"),
  };
}

export function getFoundationStatus(): FoundationStatus {
  const supabase = getSupabasePublicConfig();

  return {
    supabasePublic: present(supabase.url) && present(supabase.anonKey),
    supabaseServiceRole: present(readEnv("SUPABASE_SERVICE_ROLE_KEY")),
    gemini: present(readEnv("GEMINI_API_KEY")),
    brightData: present(readEnv("BRIGHTDATA_API_TOKEN")),
    brightDataMcp: present(readEnv("BRIGHTDATA_MCP_API_KEY")) || present(readEnv("BRIGHTDATA_MCP_URL")),
    shopify: (() => {
      const hasStaticToken = present(readEnv("SHOPIFY_ADMIN_ACCESS_TOKEN"));
      const hasClientCredentials = present(readEnv("SHOPIFY_CLIENT_ID")) && present(readEnv("SHOPIFY_CLIENT_SECRET"));
      const mode = readEnv("SHOPIFY_AUTH_MODE");
      const modeValid = mode === "client_credentials"
        ? hasClientCredentials
        : mode === "static_admin_token"
          ? hasStaticToken
          : !mode && (hasStaticToken !== hasClientCredentials);
      return present(readEnv("SHOPIFY_STORE_DOMAIN")) && modeValid;
    })(),
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
    faire: present(readEnv("FAIRE_ACCESS_TOKEN")),
    dsersMcp: present(readEnv("DSERS_MCP_URL")) && present(readEnv("DSERS_MCP_ACCESS_TOKEN")),
    printful: present(readEnv("PRINTFUL_ACCESS_TOKEN")),
    ecPulse: present(readEnv("EC_PULSE_API_KEY")),
    extension: present(readEnv("TRACER_EXTENSION_API_KEY")),
    base: present(readEnv("BASE_CLIENT_ID")) &&
      present(readEnv("BASE_CLIENT_SECRET")) &&
      present(readEnv("BASE_REFRESH_TOKEN")) &&
      present(readEnv("BASE_REDIRECT_URI")),
  };
}

export function getGeminiConfig() {
  const apiKey = readEnv("GEMINI_API_KEY");
  // A second key can be supplied to rotate around per-key quota limits.
  const apiKey2 = readEnv("GEMINI_API_KEY_2");
  const apiKeys = [apiKey, apiKey2].filter((key, index, keys) => Boolean(key) && keys.indexOf(key) === index);
  const configuredModel = readEnv("GEMINI_MODEL");
  // Gemini 2.5 Flash is no longer available to some new API projects.
  // Migrate the legacy default and legacy explicit setting to the current stable model.
  const model = !configuredModel || configuredModel === "gemini-2.5-flash"
    ? "gemini-3.8-flash"
    : configuredModel;
  return { apiKey, apiKey2, apiKeys, model };
}

export function getBrightDataConfig() {
  return {
    apiToken: readEnv("BRIGHTDATA_API_TOKEN"),
    zone: readEnv("BRIGHTDATA_ZONE"),
    mcpUrl: readEnv("BRIGHTDATA_MCP_URL"),
    mcpApiKey: readEnv("BRIGHTDATA_MCP_API_KEY"),
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

export function getCorecConfig() {
  return {
    clientId: readEnv("COREC_CLIENT_ID"),
    clientSecret: readEnv("COREC_CLIENT_SECRET"),
    redirectUri: readEnv("COREC_REDIRECT_URI"),
    sessionSecret: readEnv("COREC_SESSION_SECRET"),
    scope: readEnv("COREC_SCOPE") || "read_buyer_orders",
  };
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

export function getPrintfulConfig() {
  return {
    accessToken: readEnv("PRINTFUL_ACCESS_TOKEN"),
    storeId: readEnv("PRINTFUL_STORE_ID"),
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
    hypersku: present(readEnv("HYPERSKU_API_KEY")),
    dsers: present(readEnv("DSERS_API_KEY")),
    zendrop: present(readEnv("ZENDROP_API_KEY")),
    syncee: present(readEnv("SYNCEE_API_KEY")),
    faire: present(readEnv("FAIRE_ACCESS_TOKEN")),
  };
}

export function isSupplierConfigured(supplierName: string): boolean {
  const name = supplierName.trim().toLowerCase();
  if (name === "cj" || name === "cjdropshipping") return present(getCJConfig().apiKey);
  if (name === "faire") return present(readEnv("FAIRE_ACCESS_TOKEN"));
  if (name === "dsers") return present(readEnv("DSERS_MCP_ACCESS_TOKEN"));
  if (name === "printful") return present(readEnv("PRINTFUL_ACCESS_TOKEN"));
  if (name === "tracer_internal") return true;
  return false;
}

export function isSupplierLiveOrderingEnabled(supplierName: string): boolean {
  const key = supplierName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").toUpperCase();
  if (key === "CJ" || key === "CJDROPSHIPPING") return isCJLiveOrderingEnabled();
  if (key === "TRACER_INTERNAL") return readEnv("TRACER_INTERNAL_LIVE_ORDERING") === "1";
  return readEnv(`${key}_LIVE_ORDERING`) === "1";
}

export function isSupplierAutoOrderingEnabled(supplierName: string): boolean {
  const key = supplierName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").toUpperCase();
  if (key === "CJ" || key === "CJDROPSHIPPING") return isCJAutoOrderingEnabled();
  if (key === "TRACER_INTERNAL") return readEnv("TRACER_INTERNAL_AUTO_ORDERING") === "1";
  return readEnv(`${key}_AUTO_ORDERING`) === "1";
}

export function isTeacherWeightApplyEnabled(): boolean {
  return readEnv("TEACHER_APPLY_WEIGHTS") === "1";
}

export function getShopifyConfig() {
  return {
    storeDomain: readEnv("SHOPIFY_STORE_DOMAIN"),
    adminAccessToken: readEnv("SHOPIFY_ADMIN_ACCESS_TOKEN"),
    clientId: readEnv("SHOPIFY_CLIENT_ID"),
    clientSecret: readEnv("SHOPIFY_CLIENT_SECRET"),
    authMode: readEnv("SHOPIFY_AUTH_MODE"),
    apiVersion: readEnv("SHOPIFY_API_VERSION") || "2026-07",
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

export function isSupplierDryRunEnabled(): boolean {
  return readEnv("SUPPLIER_DRY_RUN") !== "0";
}
