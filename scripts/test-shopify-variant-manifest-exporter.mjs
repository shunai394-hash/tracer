import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("exports deterministic safety counts and refuses to overwrite an existing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracer-variant-manifest-"));
  const input = join(dir, "input.json");
  const output = join(dir, "manifest.json");
  const rows = [
    {
      product_id: "p1", source_key: "cj:parent1", variant_id: "v1",
      supplier_code: "cj", supplier_product_id: "12345678901", supplier_variant_id: "12345678902",
      sku: "TRC-V1", selling_price: 2000, inventory: 5,
      shopify_product_id: null, shopify_variant_id: null, base_item_id: "base1",
    },
    {
      product_id: "p1", source_key: "cj:parent1", variant_id: "v2",
      supplier_code: "cj", supplier_product_id: "12345678901", supplier_variant_id: "12345678903",
      sku: "TRC-V2", selling_price: 2200, inventory: 3,
      shopify_product_id: null, shopify_variant_id: null, base_item_id: "base2",
    },
  ];
  try {
    writeFileSync(input, JSON.stringify(rows));
    const script = resolve("scripts/export-shopify-variant-grouping-manifest.mjs");
    const result = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.mode, "read_only_no_channel_mutations");
    assert.equal(manifest.inputRowCount, 2);
    assert.equal(manifest.groupCount, 1);
    assert.equal(manifest.variantCount, 2);
    assert.equal(manifest.eligibleForDryRunReviewCount, 1);
    assert.equal(manifest.blockedGroupCount, 0);

    const secondRun = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
    assert.equal(secondRun.status, 1);
    assert.match(secondRun.stderr, /EEXIST|file already exists/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a non-array input and input/output path collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracer-variant-manifest-invalid-"));
  const input = join(dir, "input.json");
  try {
    writeFileSync(input, JSON.stringify({ rows: [] }));
    const script = resolve("scripts/export-shopify-variant-grouping-manifest.mjs");
    const nonArray = spawnSync(process.execPath, [script, input, join(dir, "out.json")], { encoding: "utf8" });
    assert.equal(nonArray.status, 1);
    assert.match(nonArray.stderr, /input_json_must_be_array/);
    const collision = spawnSync(process.execPath, [script, input, input], { encoding: "utf8" });
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /input_and_output_paths_must_differ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
