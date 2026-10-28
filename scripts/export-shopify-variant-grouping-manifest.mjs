#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { planShopifyVariantGroups } from "../lib/commerce/shopify-variant-grouping.mjs";

function usage() {
  console.error("Usage: node scripts/export-shopify-variant-grouping-manifest.mjs <input.json> <output.json>");
  console.error("Input must be a JSON array of canonical variant rows. This tool is read-only and never calls channel APIs.");
  process.exitCode = 2;
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  usage();
} else {
  try {
    const inputPath = resolve(inputArg);
    const outputPath = resolve(outputArg);
    if (inputPath === outputPath) throw new Error("input_and_output_paths_must_differ");
    const raw = await readFile(inputPath, "utf8");
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error("input_json_must_be_array");

    const groups = planShopifyVariantGroups(rows);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: "read_only_no_channel_mutations",
      inputRowCount: rows.length,
      groupCount: groups.length,
      eligibleForDryRunReviewCount: groups.filter((group) => group.canProceedToDryRunReview).length,
      blockedGroupCount: groups.filter((group) => !group.canProceedToDryRunReview).length,
      variantCount: groups.reduce((sum, group) => sum + group.variantCount, 0),
      groups,
    };
    await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({
      outputPath,
      inputRowCount: manifest.inputRowCount,
      groupCount: manifest.groupCount,
      eligibleForDryRunReviewCount: manifest.eligibleForDryRunReviewCount,
      blockedGroupCount: manifest.blockedGroupCount,
      variantCount: manifest.variantCount,
      mode: manifest.mode,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
