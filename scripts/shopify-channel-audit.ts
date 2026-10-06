import { isShopifyConfigured } from "@/lib/shopify/admin";

const checks = {
  storeDomain: Boolean(process.env.SHOPIFY_STORE_DOMAIN?.trim()),
  adminAccessToken: Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim()),
  webhookSecret: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET?.trim()),
  configured: isShopifyConfigured(),
};

const result = {
  ok: checks.configured,
  channel: "shopify",
  storefrontContract: "published + gate-passed + synced + in-stock + orderable + trackable",
  checks: {
    storeDomain: checks.storeDomain,
    adminAccessToken: checks.adminAccessToken,
    webhookSecret: checks.webhookSecret,
    configured: checks.configured,
  },
  requiredForCatalogSync: ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"],
  secretValuesPrinted: false,
};

console.log(JSON.stringify(result, null, 2));
if (!checks.configured) process.exit(1);
