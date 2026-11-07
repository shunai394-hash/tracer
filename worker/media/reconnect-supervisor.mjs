const DEFAULT_BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_RETRIES = 8;

/**
 * Bounded reconnect coordinator. A platform/media adapter calls
 * notifyDisconnected() after detecting a dropped RTMP session. It never
 * retries authentication/eligibility failures or moderation handoffs.
 */
export function createReconnectSupervisor({
  startAttempt,
  stopAttempt,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
  sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("reconnect_aborted"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  }),
  onState = () => {},
} = {}) {
  if (typeof startAttempt !== "function" || typeof stopAttempt !== "function") {
    throw new Error("startAttempt and stopAttempt are required");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) {
    throw new Error("maxRetries must be between 0 and 20");
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 100 || baseDelayMs > 30_000 ||
      !Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 300_000) {
    throw new Error("invalid reconnect delay bounds");
  }

  let state = "idle";
  let retries = 0;
  let controller = null;
  let activeLoop = null;
  let lastFailure = null;
  let stopped = false;

  function snapshot() {
    return { state, retries, maxRetries, lastFailure };
  }

  function setState(next, failure = lastFailure) {
    state = next;
    lastFailure = failure;
    onState(snapshot());
  }

  async function retryLoop() {
    // Tear down any partially connected or disconnected publisher before a
    // retry. stopAttempt must be idempotent; this prevents overlapping FFmpeg
    // processes and stale RTMP sessions during reconnect.
    try { await stopAttempt(); } catch {}
    while (!stopped && retries < maxRetries) {
      retries += 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (retries - 1)));
      setState("waiting_to_reconnect");
      try {
        await sleep(delay, controller.signal);
      } catch {
        if (stopped) break;
        setState("failed", "reconnect_wait_failed");
        return snapshot();
      }
      if (stopped) break;
      setState("reconnecting");
      try {
        await startAttempt();
        if (stopped) {
          await stopAttempt().catch(() => {});
          break;
        }
        setState("connected", null);
        return snapshot();
      } catch {
        lastFailure = "reconnect_attempt_failed";
      }
    }
    if (stopped) setState("stopped");
    else setState("failed", "reconnect_limit_reached");
    return snapshot();
  }

  return {
    snapshot,
    async start() {
      if (state === "connected") return snapshot();
      if (activeLoop) return activeLoop;
      stopped = false;
      retries = 0;
      controller = new AbortController();
      setState("connecting", null);
      activeLoop = (async () => {
        try {
          await startAttempt();
          if (!stopped) setState("connected", null);
          return snapshot();
        } catch {
          lastFailure = "initial_connect_failed";
          return retryLoop();
        }
      })().finally(() => { activeLoop = null; });
      return activeLoop;
    },
    async notifyDisconnected(reason = "connection_lost") {
      if (stopped || state === "stopped" || state === "failed") return snapshot();
      if (activeLoop) return activeLoop;
      lastFailure = /^[a-z0-9_]{1,64}$/i.test(reason) ? reason : "connection_lost";
      controller = new AbortController();
      activeLoop = retryLoop().finally(() => { activeLoop = null; });
      return activeLoop;
    },
    async stop() {
      stopped = true;
      controller?.abort();
      try { await stopAttempt(); } catch {}
      if (activeLoop) await activeLoop.catch(() => {});
      setState("stopped");
      return snapshot();
    },
  };
}
