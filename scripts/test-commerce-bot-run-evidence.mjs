import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMERCE_BOT_RUN_EVENT_TYPES,
  validateCommerceBotRunEvent,
} from "../lib/agents/commerce-bot-run-evidence.ts";

const valid = validateCommerceBotRunEvent({
  runId: "123e4567-e89b-12d3-a456-426614174000",
  botId: "channel-sync",
  eventType: "run_started",
  status: "running",
  inputSnapshotHash: "sha256:abc123",
  evidenceRefs: ["reconcile:run-1"],
  blockers: [],
  retryCount: 0,
  idempotencyKey: "channel-sync:2026-10-28:run-1",
  metadata: { mode: "read-only" },
});
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.value.evidenceRefs?.length, 1);
  assert.equal(valid.value.retryCount, 0);
}

assert.equal(validateCommerceBotRunEvent(null).ok, false);
assert.equal(validateCommerceBotRunEvent({ runId: "bad", botId: "main", eventType: "run_started", status: "running" }).ok, false);
assert.equal(validateCommerceBotRunEvent({ runId: "123e4567-e89b-12d3-z456-426614174000", botId: "main", eventType: "run_started", status: "running" }).ok, false);
assert.equal(validateCommerceBotRunEvent({ runId: "123e4567-e89b-12d3-a456-42661417400", botId: "main", eventType: "run_started", status: "running" }).ok, false);
assert.equal(validateCommerceBotRunEvent({
  runId: "123e4567-e89b-12d3-a456-426614174000",
  botId: "unknown",
  eventType: "run_started",
  status: "passed",
}).ok, false);
assert.equal(validateCommerceBotRunEvent({
  runId: "123e4567-e89b-12d3-a456-426614174000",
  botId: "qa",
  eventType: "unknown",
  status: "passed",
}).ok, false);
assert.equal(validateCommerceBotRunEvent({
  runId: "123e4567-e89b-12d3-a456-426614174000",
  botId: "qa",
  eventType: "passed",
  status: "passed",
  retryCount: -1,
}).ok, false);
assert.ok(COMMERCE_BOT_RUN_EVENT_TYPES.includes("failed"));

const migration = readFileSync(new URL("../supabase/migrations/20261028100000_commerce_bot_run_events.sql", import.meta.url), "utf8");
assert.match(migration, /create table if not exists public\.commerce_bot_run_events/);
assert.match(migration, /enable row level security/i);
assert.match(migration, /revoke update, delete, truncate/i);
assert.match(migration, /unique \(idempotency_key\)/);
console.log("Commerce bot run evidence tests passed");


const historyRoute = readFileSync(new URL("../app/api/admin/bots/runs/route.ts", import.meta.url), "utf8");
assert.match(historyRoute, /requireAutomationAuth\(request\)/);
assert.match(historyRoute, /\.from\("commerce_bot_run_events"\)/);
assert.match(historyRoute, /\.order\("occurred_at", \{ ascending: false \}\)/);
assert.match(historyRoute, /Math\.min\(100, limitParam\)/);
assert.match(historyRoute, /invalid_run_id/);
assert.match(historyRoute, /invalid_bot_id/);
console.log("Commerce bot run history API guardrails passed");
