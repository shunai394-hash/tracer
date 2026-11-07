import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDestinationSecretProvider } from "./destination-secret-provider.mjs";

const root = await mkdtemp(path.join(tmpdir(), "tracer-ai-live-secrets-"));
const outside = await mkdtemp(path.join(tmpdir(), "tracer-ai-live-secret-outside-"));
try {
  await mkdir(path.join(root, "live", "youtube"), { recursive: true });
  await mkdir(path.join(root, "live", "tiktok"), { recursive: true });
  await writeFile(
    path.join(root, "live", "youtube", "primary.json"),
    JSON.stringify({ accessToken: "fixture-token", refreshToken: "fixture-refresh" }),
  );
  await writeFile(path.join(outside, "escape.json"), JSON.stringify({ streamKey: "must-not-read" }));
  await symlink(
    path.join(outside, "escape.json"),
    path.join(root, "live", "tiktok", "current.json"),
  );
  await writeFile(path.join(root, "large.json"), JSON.stringify({ value: "x".repeat(17 * 1024) }));
  await writeFile(path.join(root, "broken.json"), "{not-json");
  await writeFile(path.join(root, "array.json"), "[]");

  const provider = createDestinationSecretProvider({ rootDir: root });
  const value = await provider.read("live/youtube/primary");
  assert.equal(value.accessToken, "fixture-token");
  assert.equal(value.refreshToken, "fixture-refresh");
  assert.equal(Object.isFrozen(value), true);

  await assert.rejects(() => provider.read("../escape"), /destination_secret_reference_invalid/);
  await assert.rejects(() => provider.read("live/tiktok/current"), /destination_secret_symlink_rejected/);
  await assert.rejects(() => provider.read("missing/secret"), /destination_secret_not_found/);
  await assert.rejects(() => provider.read("large"), /destination_secret_size_out_of_bounds/);
  await assert.rejects(() => provider.read("broken"), /destination_secret_invalid_json/);
  await assert.rejects(() => provider.read("array"), /destination_secret_invalid_shape/);

  console.log("AI Live destination secret provider: path, symlink, size, and JSON checks passed.");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
