import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../docs/ai-live-bgm-library-manifest.json", import.meta.url), "utf8"),
);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.policy.licenseStatus, "unverified");
assert.equal(manifest.policy.eligibleForProductionPlayback, false);
assert.equal(manifest.tracks.length, 17);

const paths = new Set();
const hashes = new Set();
for (const track of manifest.tracks) {
  assert.equal(typeof track.path, "string");
  assert.ok(track.path.endsWith(".mp3"));
  assert.ok(!track.path.startsWith("/") && !track.path.includes(".."));
  assert.ok(Number.isInteger(track.sizeBytes) && track.sizeBytes > 0);
  assert.ok(track.sizeBytes <= 10 * 1024 * 1024);
  assert.match(track.sha256, /^[a-f0-9]{64}$/);
  assert.equal(track.licenseStatus, "unverified");
  assert.equal(track.productionEligible, false);
  assert.ok(!paths.has(track.path), `duplicate path: ${track.path}`);
  assert.ok(!hashes.has(track.sha256), `duplicate content hash: ${track.sha256}`);
  paths.add(track.path);
  hashes.add(track.sha256);
}

console.log("AI Live BGM manifest: 17 tracks, unique paths/hashes, all production-blocked until license verification.");
