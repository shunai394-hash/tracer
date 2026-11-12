/**
 * Long-running AI live worker. Bind is loopback only.
 * YouTube and TikTok are refused. The process does not open RTMP and does not print secrets.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResidentSession } from "../lib/ai-live/resident-worker.ts";

const stateDir = process.env.TRACER_AI_LIVE_STATE_DIR || "";
if (!stateDir) {
  console.log(JSON.stringify({ ok: false, errorCode: "state_dir_required", publicBroadcast: false }));
  process.exit(1);
}
mkdirSync(stateDir, { recursive: true });

const lockPath = join(stateDir, "worker.lock");
const statePath = join(stateDir, "state.json");
const portPath = join(stateDir, "port.json");

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (existsSync(lockPath)) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (pidAlive(lock.pid) && lock.pid !== process.pid) {
      console.log(JSON.stringify({ ok: false, errorCode: "duplicate_worker", publicBroadcast: false }));
      process.exit(2);
    }
  } catch {
    // A broken lock belongs to a dead process and can be replaced.
  }
}
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

const session = new ResidentSession();
try {
  if (existsSync(statePath)) session.restore(JSON.parse(readFileSync(statePath, "utf8")));
} catch {
  session.restore(null);
}
if (session.health.state === "live" || session.health.state === "reconnecting") {
  session.reconnect(new Date().toISOString());
}

function persist() {
  writeFileSync(statePath, JSON.stringify(session.snapshot()));
}
persist();

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(Object.assign(new Error("body_too_large"), { code: "body_too_large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  if (session.health.state === "live" || session.health.state === "starting" || session.health.state === "reconnecting") {
    session.stop(session.health.streamId, reason, new Date().toISOString());
  }
  persist();
  rmSync(lockPath, { force: true });
  rmSync(portPath, { force: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      session.expire(Date.now());
      persist();
      send(response, 200, session.snapshot());
      return;
    }
    if (request.method !== "POST") {
      send(response, 404, { ok: false, errorCode: "not_found", publicBroadcast: false });
      return;
    }
    const raw = await readBody(request);
    const body = raw ? JSON.parse(raw) : {};
    const now = new Date().toISOString();
    let result;
    if (url.pathname === "/start") result = session.start(body, now);
    else if (url.pathname === "/stop") result = session.stop(String(body.streamId || ""), String(body.reason || "operator_requested"), now);
    else if (url.pathname === "/reconnect") result = session.reconnect(now);
    else if (url.pathname === "/shutdown") {
      send(response, 200, { ok: true, publicBroadcast: false, state: "stopped" });
      shutdown("worker_shutdown");
      return;
    } else {
      send(response, 404, { ok: false, errorCode: "not_found", publicBroadcast: false });
      return;
    }
    persist();
    send(response, result.ok ? 200 : 409, result);
  } catch (error) {
    const code = error?.code === "body_too_large" ? "body_too_large" : "invalid_json";
    send(response, 400, { ok: false, errorCode: code, publicBroadcast: false });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(portPath, JSON.stringify({ port, host: "127.0.0.1" }));
  console.log(JSON.stringify({ ok: true, ready: true, port, host: "127.0.0.1", publicBroadcast: false }));
});

process.on("SIGTERM", () => shutdown("worker_shutdown"));
process.on("SIGINT", () => shutdown("worker_shutdown"));
setInterval(() => {
  session.expire(Date.now());
  persist();
}, 5_000).unref();
