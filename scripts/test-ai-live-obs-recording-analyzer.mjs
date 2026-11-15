import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const analyzer = join(root, "scripts", "analyze-ai-live-obs-recording.mjs");
const dir = mkdtempSync(join(tmpdir(), "tracer-obs-audio-test-"));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

try {
  const crashFile = join(dir, "crash.wav");
  const continuousFile = join(dir, "continuous.wav");
  const generated = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "aevalsrc=if(lt(t\\,5)\\,0.2*sin(2*PI*440*t)\\,0):s=48000:d=10",
    "-c:a", "pcm_s16le", crashFile,
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const continuous = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
    "-c:a", "pcm_s16le", continuousFile,
  ]);
  assert.equal(continuous.status, 0, continuous.stderr);

  const pass = run(process.execPath, [
    analyzer, "--file", crashFile, "--crash-at", "5", "--window-sec", "4",
  ]);
  assert.equal(pass.status, 0, pass.stderr);
  const passResult = JSON.parse(pass.stdout);
  assert.equal(passResult.verdict, "PASS");
  assert.equal(passResult.checks.audibleBeforeCrash, true);
  assert.equal(passResult.checks.silentAfterCrash, true);

  const fail = run(process.execPath, [
    analyzer, "--file", continuousFile, "--crash-at", "5", "--window-sec", "4",
  ]);
  assert.equal(fail.status, 1, fail.stderr);
  const failResult = JSON.parse(fail.stdout);
  assert.equal(failResult.verdict, "FAIL");
  assert.equal(failResult.checks.audibleBeforeCrash, true);
  assert.equal(failResult.checks.silentAfterCrash, false);

  console.log("OBS recording analyzer PASS/FAIL fixtures passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
