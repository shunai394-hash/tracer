import assert from "node:assert/strict";
import {
  buildCommerceBotStatusReport,
  COMMERCE_BOTS,
  getCommerceBotStatus,
  getMissingCommerceBotEnvironment,
} from "../lib/agents/commerce-bot-control-plane.ts";

const empty = buildCommerceBotStatusReport({});
assert.equal(empty.mode, "read-only-status");
assert.equal(empty.externalWritesEnabledByThisEndpoint, false);
assert.equal(empty.bots.length, 5);
assert.ok(empty.bots.every((bot) => bot.executionClaim === "not-run"));
assert.ok(empty.blockers.some((item) => item.code === "MISSING_CONFIGURATION"));
assert.equal(empty.bots.find((bot) => bot.id === "product-monitor").status, "needs-configuration");

const configured = buildCommerceBotStatusReport({
  CRON_SECRET: "test-secret",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  CJ_API_KEY: "cj-test",
  GEMINI_API_KEY: "gemini-test",
  BASE_CLIENT_ID: "base-id",
  BASE_CLIENT_SECRET: "base-secret",
  BASE_REFRESH_TOKEN: "base-refresh",
  BASE_REDIRECT_URI: "https://example.test/callback",
  SHOPIFY_STORE_DOMAIN: "example.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "shopify-test",
  SHOPIFY_AUTH_MODE: "static_admin_token",
  NEWFIND_API_URL: "https://newfind.example.test",
  NEWFIND_API_KEY: "newfind-test",
});
assert.equal(configured.bots.find((bot) => bot.id === "main").status, "route-backed");
assert.equal(configured.bots.find((bot) => bot.id === "product-monitor").status, "route-backed");
assert.equal(configured.bots.find((bot) => bot.id === "qa").status, "read-only-foundation");
assert.ok(configured.bots.every((bot) => bot.executionClaim === "not-run"));

const sync = COMMERCE_BOTS.find((bot) => bot.id === "channel-sync");
assert.ok(sync);
assert.equal(sync.writesExternalSystems, true);
assert.match(sync.approvalGate, /読み取り照合/);
assert.equal(getCommerceBotStatus(sync, {}), "needs-configuration");
assert.ok(getMissingCommerceBotEnvironment(sync, {}).includes("SHOPIFY_STORE_DOMAIN"));
const syncConfigured = getMissingCommerceBotEnvironment(sync, {
  CRON_SECRET: "test-secret",
  BASE_CLIENT_ID: "base-id", BASE_CLIENT_SECRET: "base-secret", BASE_REFRESH_TOKEN: "base-refresh", BASE_REDIRECT_URI: "https://example.test/callback",
  SHOPIFY_STORE_DOMAIN: "example.myshopify.com", SHOPIFY_CLIENT_ID: "client-id", SHOPIFY_CLIENT_SECRET: "client-secret", SHOPIFY_AUTH_MODE: "client_credentials",
  NEWFIND_API_URL: "https://newfind.example.test", NEWFIND_API_KEY: "newfind-test",
});
assert.deepEqual(syncConfigured, []);

console.log("Commerce bot control plane tests passed");
