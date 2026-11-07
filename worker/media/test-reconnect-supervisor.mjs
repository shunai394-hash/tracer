import assert from "node:assert/strict";
import { createReconnectSupervisor } from "./reconnect-supervisor.mjs";

let starts = 0;
let stops = 0;
const delays = [];
const states = [];
const supervisor = createReconnectSupervisor({
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 400,
  sleep: async (ms) => { delays.push(ms); },
  startAttempt: async () => {
    starts += 1;
    if (starts < 3) throw new Error("network_down");
  },
  stopAttempt: async () => { stops += 1; },
  onState: (snapshot) => states.push(snapshot.state),
});
assert.equal((await supervisor.start()).state, "connected");
assert.equal(starts, 3);
assert.deepEqual(delays, [100, 200]);
assert.equal(supervisor.snapshot().retries, 2);
await supervisor.notifyDisconnected("rtmp_disconnected");
assert.equal(supervisor.snapshot().state, "connected");
assert.equal(starts, 4);
assert.equal(stops, 2, "stale publisher is stopped before reconnect");
assert.deepEqual(delays, [100, 200, 400]);
await supervisor.stop();
assert.equal(supervisor.snapshot().state, "stopped");
assert.equal(stops, 3, "publisher is stopped before retries and on final shutdown");
assert.ok(states.includes("waiting_to_reconnect"));
assert.ok(states.includes("reconnecting"));

let failedStarts = 0;
const exhausted = createReconnectSupervisor({
  maxRetries: 2,
  baseDelayMs: 100,
  sleep: async () => {},
  startAttempt: async () => { failedStarts += 1; throw new Error("offline"); },
  stopAttempt: async () => {},
});
assert.equal((await exhausted.start()).state, "failed");
assert.equal(failedStarts, 3);
assert.equal(exhausted.snapshot().lastFailure, "reconnect_limit_reached");
await exhausted.stop();
assert.equal(exhausted.snapshot().state, "stopped");

assert.throws(() => createReconnectSupervisor({
  maxRetries: 100,
  startAttempt: async () => {},
  stopAttempt: async () => {},
}), /maxRetries/);
console.log("AI Live reconnect supervisor bounded retry contract: all assertions passed");
