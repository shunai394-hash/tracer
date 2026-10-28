import assert from "node:assert/strict";
import {
  buildCommerceBotStatusReport,
  COMMERCE_BOTS,
  getCommerceBotStatus,
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
  SUPABASE_URL: "https://example.supabase.co",
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

console.log("Commerce bot control plane tests passed");
