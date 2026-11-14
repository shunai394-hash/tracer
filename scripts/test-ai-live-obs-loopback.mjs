import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const adminToken = "resident-admin-test-token";
const productsToken = "products-read-token";
const fingerprint = "b".repeat(32);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tracer-obs-loopback-"));
const avatarFile = join(root, "avatar.mp4");
const bgmFile = join(root, "bed.wav");
const speechFile = join(root, "speech.wav");

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "ffmpeg failed");
}

runFfmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", avatarFile]);
runFfmpeg(["-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*150*t):s=48000:d=5", "-c:a", "pcm_s16le", bgmFile]);
runFfmpeg([
  "-f", "lavfi", "-i", "aevalsrc=0:s=48000:d=0.6",
  "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*3000*t):s=48000:d=1",
  "-f", "lavfi", "-i", "aevalsrc=0:s=48000:d=1.2",
  "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*3000*t):s=48000:d=1",
  "-f", "lavfi", "-i", "aevalsrc=0:s=48000:d=1.2",
  "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1",
  "-c:a", "pcm_s16le", speechFile,
]);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startCatalog() {
  const product = {
    id: "bag-1",
    sellingPrice: 12800,
    inventory: 2,
    inStock: true,
    updatedAt: new Date().toISOString(),
    supplierConfirmed: true,
    supplierFingerprint: fingerprint,
  };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${productsToken}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    const payload = JSON.stringify({ ok: true, readOnly: true, products: [product] });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/products`,
        close() {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

function forceStop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    return;
  }
  child.kill("SIGKILL");
}

function startWorker(stateDir, extraEnv) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "worker/ai-live-resident.mjs"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TRACER_AI_LIVE_STATE_DIR: stateDir,
      TRACER_AI_LIVE_ADMIN_TOKEN: adminToken,
      TRACER_AI_LIVE_PRODUCTS_URL: catalogUrl,
      TRACER_AI_LIVE_PRODUCTS_TOKEN: productsToken,
      TRACER_AI_LIVE_AVATAR_VIDEO: avatarFile,
      TRACER_AI_LIVE_BGM_PATH: bgmFile,
      TRACER_AI_LIVE_SPEECH_PATH: speechFile,
      TRACER_AI_LIVE_MEDIA_START_TIMEOUT_MS: "5000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return { child, read: () => output };
}

async function waitFor(check, label, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(label);
}

async function request(port, path, body) {
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function job(streamId) {
  return {
    streamId,
    destination: "loopback",
    destinationSecretRef: "worker-secret-slot",
    maxRuntimeSeconds: 600,
    segments: [{
      id: "segment-1",
      productId: "bag-1",
      scriptText: "レザー調 レディースハンドバッグです。価格は12,800円です。",
      factsVersion: "v1",
      factsVerifiedAt: new Date().toISOString(),
      sellingPrice: 12800,
      inventory: 2,
      supplierFingerprint: fingerprint,
    }],
  };
}

function windowMeanDb(file, start, seconds, frequency) {
  const probe = spawnSync("ffmpeg", [
    "-hide_banner",
    "-ss", String(start), "-t", String(seconds), "-i", file,
    "-af", `bandpass=f=${frequency}:width_type=h:w=24,volumedetect`,
    "-f", "null", "-",
  ], { encoding: "utf8" });
  const match = `${probe.stderr}`.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(match, `no mean volume at ${start} for ${frequency}Hz: ${probe.stderr}`);
  return Number(match[1]);
}

const catalog = await startCatalog();
const catalogUrl = catalog.url;
const workers = [];
let receiver = null;

try {
  const rejectedDir = join(root, "rejected");
  const rejected = startWorker(rejectedDir, { TRACER_AI_LIVE_OBS_LOOPBACK_URL: "rtmp://a.rtmp.youtube.com/live2" });
  workers.push(rejected);
  const rejectedPort = await waitFor(() => {
    const portFile = join(rejectedDir, "port.json");
    return existsSync(portFile) ? JSON.parse(readFileSync(portFile, "utf8")) : null;
  }, "rejected worker did not listen");
  const rejectedStart = await request(rejectedPort.port, "/start", job("obs-reject"));
  assert.equal(rejectedStart.status, 409);
  assert.equal(rejectedStart.body.errorCode, "media_output_rejected");
  assert.equal(rejectedStart.body.health.state, "failed");
  assert.notEqual(rejectedStart.body.health.state, "live");
  assert.equal(rejectedStart.body.health.mediaReady, false);
  assert.equal(rejectedStart.body.publicBroadcast, false);
  assert.equal(existsSync(join(rejectedDir, "introduction.mp4")), false);
  assert.equal(rejected.read().includes(adminToken), false);
  assert.equal(rejected.read().includes("youtube"), false);
  await request(rejectedPort.port, "/shutdown", {});

  const ingestPort = await reservePort();
  const ingestUrl = `rtmp://127.0.0.1:${ingestPort}/live/obs`;
  const receivedFile = join(root, "received.flv");
  receiver = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-listen", "1", "-i", ingestUrl,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c", "copy", "-f", "flv", receivedFile,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  receiver.stderr.on("data", () => {});
  await once(receiver, "spawn");
  await new Promise((resolve) => setTimeout(resolve, 400));

  const liveDir = join(root, "live");
  const live = startWorker(liveDir, { TRACER_AI_LIVE_OBS_LOOPBACK_URL: ingestUrl });
  workers.push(live);
  const livePort = await waitFor(() => {
    const portFile = join(liveDir, "port.json");
    return existsSync(portFile) ? JSON.parse(readFileSync(portFile, "utf8")) : null;
  }, "live worker did not listen");
  const started = await request(livePort.port, "/start", job("obs-live"));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.health.state, "live");
  assert.equal(started.body.health.mediaReady, true);
  assert.equal(started.body.health.publicBroadcast, false);
  assert.equal(started.body.health.productFacts.valid, true);
  assert.equal(started.body.health.destination, "loopback");
  const ready = await request(livePort.port, "/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.publicBroadcast, false);
  assert.ok(statSync(join(liveDir, "introduction.mp4")).size > 0);
  await waitFor(() => {
    if (!existsSync(receivedFile) || statSync(receivedFile).size < 400_000) return null;
    return true;
  }, "local ingest did not receive audio and video", 20_000);
  const stopped = await request(livePort.port, "/stop", { streamId: "obs-live", reason: "operator_requested" });
  assert.equal(stopped.body.health.state, "stopped");
  assert.notEqual(stopped.body.health.state, "live");
  await waitFor(() => {
    const first = statSync(receivedFile).size;
    return new Promise((resolve) => {
      setTimeout(() => resolve(statSync(receivedFile).size === first ? true : null), 300);
    });
  }, "ingest file did not finish", 10_000);

  const probed = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,duration,start_time",
    "-of", "json", receivedFile,
  ], { encoding: "utf8" });
  assert.equal(probed.status, 0, probed.stderr);
  const streams = JSON.parse(probed.stdout).streams;
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(audio?.codec_name, "aac");
  function decodedDuration(selector) {
    const decoded = spawnSync("ffmpeg", ["-hide_banner", "-i", receivedFile, "-map", selector, "-f", "null", "-"], { encoding: "utf8", timeout: 20_000 });
    const stamps = [...`${decoded.stderr}`.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    assert.ok(stamps.length > 0, decoded.stderr);
    const last = stamps.at(-1);
    return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  }
  const videoDuration = Number(video.duration) || decodedDuration("0:v:0");
  const audioDuration = Number(audio.duration) || decodedDuration("0:a:0");
  assert.ok(videoDuration > 3 && audioDuration > 3, `short receive video ${videoDuration} audio ${audioDuration}`);
  assert.ok(Math.abs(videoDuration - audioDuration) < 0.45, `avatar and audio durations diverged (${videoDuration} vs ${audioDuration})`);
  assert.ok(statSync(receivedFile).size > 10_000);

  const bedDb = windowMeanDb(receivedFile, 0.15, 0.2, 150);
  const duckDb = windowMeanDb(receivedFile, 1.15, 0.2, 150);
  const restoreDb = windowMeanDb(receivedFile, 2.15, 0.25, 150);
  const duckAgainDb = windowMeanDb(receivedFile, 3.25, 0.2, 150);
  const restoreAgainDb = windowMeanDb(receivedFile, 4.35, 0.2, 150);
  const speechDuringBed = windowMeanDb(receivedFile, 0.15, 0.2, 3000);
  const speechDuringDuck = windowMeanDb(receivedFile, 1.15, 0.2, 3000);
  const duckRatio = 10 ** ((duckDb - bedDb) / 20);
  console.log(JSON.stringify({
    mix: "obs-loopback",
    receivedBytes: statSync(receivedFile).size,
    videoDuration,
    audioDuration,
    bedDb,
    duckDb,
    restoreDb,
    duckAgainDb,
    restoreAgainDb,
    duckRatio: Number(duckRatio.toFixed(3)),
    speechDuringBed,
    speechDuringDuck,
  }));
  assert.ok(duckDb < bedDb - 8, `received BGM did not duck during speech (${duckDb} vs ${bedDb})`);
  assert.ok(Math.abs(restoreDb - bedDb) < 2.5, `received BGM did not return to 35% (${restoreDb} vs ${bedDb})`);
  assert.ok(duckAgainDb < bedDb - 8, `second speech did not duck the received BGM (${duckAgainDb} vs ${bedDb})`);
  assert.ok(Math.abs(restoreAgainDb - bedDb) < 2.5, `received BGM did not return to 35% after the second speech (${restoreAgainDb} vs ${bedDb})`);
  assert.ok(Math.abs(duckRatio - 0.18) < 0.06, `received duck ratio ${duckRatio} was not near 0.18`);
  assert.ok(speechDuringDuck > speechDuringBed + 8, "speech was not present in the same window as the duck");

  const stoppedReady = await request(livePort.port, "/ready");
  assert.equal(stoppedReady.status, 503);
  assert.equal(live.read().includes(adminToken), false);
  assert.equal(live.read().includes(productsToken), false);
  await request(livePort.port, "/shutdown", {});

  const crashDir = join(root, "crash");
  const crashScript = join(root, "crash.mjs");
  writeFileSync(crashScript, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv.at(-1), 'frame'); process.exit(3);\n");
  const crash = startWorker(crashDir, { TRACER_AI_LIVE_FFMPEG_SCRIPT: crashScript });
  workers.push(crash);
  const crashPort = await waitFor(() => {
    const portFile = join(crashDir, "port.json");
    return existsSync(portFile) ? JSON.parse(readFileSync(portFile, "utf8")) : null;
  }, "crash worker did not listen");
  const crashed = await request(crashPort.port, "/start", job("obs-crash"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const crashHealth = await request(crashPort.port, "/health");
  assert.equal(crashHealth.body.state, "failed");
  assert.notEqual(crashHealth.body.state, "live");
  assert.equal(crashHealth.body.mediaReady, false);
  assert.equal(crashHealth.body.publicBroadcast, false);
  assert.notEqual(crashed.body.health?.state, "live");
  const crashReady = await request(crashPort.port, "/ready");
  assert.equal(crashReady.status, 503);
  await request(crashPort.port, "/shutdown", {});
  console.log("OBS loopback receive, duck restore, and abnormal-exit checks passed");
} finally {
  forceStop(receiver);
  for (const worker of workers) forceStop(worker.child);
  catalog.close();
  rmSync(root, { recursive: true, force: true });
}
