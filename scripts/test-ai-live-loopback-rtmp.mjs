import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForSpawn(child, label) {
  try { await once(child, "spawn"); } catch { throw new Error(`${label}_spawn_failed`); }
}

function waitForExit(child, label, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${label}_timeout`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${label}_exit_${code ?? signal}: ${stderr}`));
      else resolve({ code, stderr });
    });
  });
}

const port = await reserveLoopbackPort();
const url = `rtmp://127.0.0.1:${port}/live/roundtrip`;
const stateDir = mkdtempSync(join(tmpdir(), "tracer-ai-live-rtmp-"));
const receivedFile = join(stateDir, "received.flv");
let receiver;
let publisher;

try {
  receiver = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-listen", "1", "-i", url,
    "-map", "0:v:0", "-map", "0:a:0",
    "-t", "2", "-c", "copy", "-f", "flv", receivedFile,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  await waitForSpawn(receiver, "loopback_rtmp_receiver");
  const receiverDone = waitForExit(receiver, "loopback_rtmp_receiver");
  receiverDone.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 350));

  publisher = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "30",
    "-c:a", "aac", "-b:a", "64k", "-ar", "48000",
    "-f", "flv", url,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  await waitForSpawn(publisher, "loopback_rtmp_publisher");
  await Promise.all([receiverDone, waitForExit(publisher, "loopback_rtmp_publisher")]);

  const outputBytes = statSync(receivedFile).size;
  assert.ok(outputBytes > 10_000, "loopback RTMP receiver did not write media data");
  const streams = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", receivedFile,
  ], { encoding: "utf8" }).trim().split(/\\r?\\n/).sort();
  assert.deepEqual(streams, ["audio", "video"]);
  console.log("AI live loopback RTMP publish/receive round-trip passed", { outputBytes, streams });
} finally {
  if (receiver && receiver.exitCode === null) receiver.kill("SIGKILL");
  if (publisher && publisher.exitCode === null) publisher.kill("SIGKILL");
  rmSync(stateDir, { recursive: true, force: true });
}
