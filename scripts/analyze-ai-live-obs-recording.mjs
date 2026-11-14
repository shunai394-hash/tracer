#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const fileArg = option("--file", "");
const crashAt = Number(option("--crash-at", ""));
const windowSeconds = Number(option("--window-sec", "5"));
const preMinDb = Number(option("--pre-min-db", "-45"));
const postMaxDb = Number(option("--post-max-db", "-60"));

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!fileArg) fail("Usage: node scripts/analyze-ai-live-obs-recording.mjs --file <recording> --crash-at <seconds> [--window-sec 5] [--pre-min-db -45] [--post-max-db -60]");
const file = resolve(fileArg);
if (!existsSync(file)) fail(`Recording not found: ${file}`);
if (!Number.isFinite(crashAt) || crashAt <= 0) fail("--crash-at must be a positive number of seconds from the start of the recording");
if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) fail("--window-sec must be positive");
if (!Number.isFinite(preMinDb) || !Number.isFinite(postMaxDb) || preMinDb <= postMaxDb) fail("--pre-min-db must be greater than --post-max-db");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed: ${result.stderr || result.stdout}`);
  return result;
}

const durationOutput = run("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", file,
]).stdout.trim();
const duration = Number(durationOutput);
if (!Number.isFinite(duration)) fail("Could not determine recording duration");
const preStart = Math.max(0, crashAt - windowSeconds);
const preDuration = crashAt - preStart;
const postStart = crashAt;
const postDuration = Math.min(windowSeconds, duration - postStart);
if (preDuration < windowSeconds * 0.8) fail("Not enough recording before --crash-at; record at least one full pre-crash window");
if (postDuration < windowSeconds * 0.8) fail("Not enough recording after --crash-at; record at least one full post-crash window");

function measure(start, length) {
  const result = run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file,
    "-ss", String(start), "-t", String(length),
    "-vn", "-af", "volumedetect", "-f", "null", "-",
  ]);
  const log = `${result.stdout}\n${result.stderr}`;
  const match = log.match(/mean_volume:\s*(-?Infinity|-?\d+(?:\.\d+)?)\s*dB/i);
  if (!match) fail("Audio measurement unavailable in one of the selected windows");
  return match[1].toLowerCase().includes("infinity") ? -Infinity : Number(match[1]);
}

const preDb = measure(preStart, preDuration);
const postDb = measure(postStart, postDuration);
const preAudible = preDb >= preMinDb;
const postSilent = postDb <= postMaxDb;
const result = {
  recording: file,
  durationSeconds: Number(duration.toFixed(2)),
  crashAtSeconds: crashAt,
  windowSeconds,
  thresholds: { preMinimumDb: preMinDb, postMaximumDb: postMaxDb },
  measured: { beforeCrashMeanDb: Number(preDb.toFixed(2)), afterCrashMeanDb: Number(postDb.toFixed(2)) },
  checks: { audibleBeforeCrash: preAudible, silentAfterCrash: postSilent },
  verdict: preAudible && postSilent ? "PASS" : "FAIL",
  note: "This checks the selected recording windows only. Confirm the crash timestamp and listen to the recording; it does not measure BGM duck ratio or prove OBS UI state.",
};
console.log(JSON.stringify(result, null, 2));
if (!preAudible || !postSilent) process.exitCode = 1;
