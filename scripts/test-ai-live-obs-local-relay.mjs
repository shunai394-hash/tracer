import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const relayScript = join(repoRoot, "scripts", "ai-live-obs-local-relay.mjs");
const procedure = readFileSync(new URL("../docs/ai-live-obs-studio-local.md", import.meta.url), "utf8");
assert.match(procedure, /127\.0\.0\.1/);
assert.match(procedure, /メディアソース/);
assert.match(procedure, /FFmpeg 同士の受信テストは OBS Studio の再生確認にはしない/);
assert.match(procedure, /未確認/);
assert.match(procedure, /YouTube/);
assert.match(procedure, /publicBroadcast/);
assert.match(procedure, /obs64\.exe/);
assert.doesNotMatch(procedure, /0\.0\.0\.0/);

const rejected = spawnSync(process.execPath, [relayScript, "--rtmp-url", "rtmp://a.rtmp.youtube.com/live2"], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.notEqual(rejected.status, 0);
assert.match(rejected.stdout, /loopback_required/);
assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /youtube-secret|Bearer /);

const directory = mkdtempSync(join(tmpdir(), "tracer-obs-relay-"));
const relay = spawn(process.execPath, [relayScript, "--directory", directory], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let relayOutput = "";
relay.stdout.on("data", (chunk) => { relayOutput += chunk.toString("utf8"); });
relay.stderr.on("data", (chunk) => { relayOutput += chunk.toString("utf8"); });

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

try {
  const readyText = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${relayOutput}`)), 8_000);
    relay.stdout.on("data", () => {
      const line = relayOutput.split(/\r?\n/).find((item) => item.includes("\"hlsUrl\""));
      if (!line) return;
      clearTimeout(timer);
      resolve(line);
    });
    relay.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`relay exited early: ${relayOutput}`));
    });
  });
  const ready = JSON.parse(readyText);
  assert.equal(ready.ok, true);
  assert.equal(ready.host, "127.0.0.1");
  assert.equal(ready.obsStudio, false);
  assert.match(ready.rtmpUrl, /^rtmp:\/\/127\.0\.0\.1:\d+\/live\/obs$/);
  assert.match(ready.hlsUrl, /^http:\/\/127\.0\.0\.1:\d+\/index\.m3u8$/);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const publisher = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", "-ar", "48000",
    "-f", "flv", ready.rtmpUrl,
  ], { stdio: "ignore", windowsHide: true });
  let playlist = "";
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12_000) {
    const response = await fetch(ready.hlsUrl).catch(() => null);
    if (response?.ok) {
      playlist = await response.text();
      if (playlist.includes(".ts")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.match(playlist, /\.ts/);
  const segmentName = playlist.split(/\r?\n/).find((line) => line.endsWith(".ts"));
  const segmentUrl = new URL(segmentName, ready.hlsUrl);
  assert.equal(segmentUrl.hostname, "127.0.0.1");
  const segment = await fetch(segmentUrl);
  assert.equal(segment.status, 200);
  assert.ok((await segment.arrayBuffer()).byteLength > 100);
  const outside = await fetch(new URL("/../package.json", ready.hlsUrl).href).catch(() => null);
  if (outside) assert.equal(outside.status, 404);
  stop(publisher);
  console.log(JSON.stringify({
    relay: "loopback-hls",
    obsStudio: false,
    rtmpUrl: ready.rtmpUrl,
    hlsUrl: ready.hlsUrl,
    segmentBytes: "received",
  }));
} finally {
  stop(relay);
  rmSync(directory, { recursive: true, force: true });
}
