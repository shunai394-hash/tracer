import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const parser = await readFile(new URL("../lib/market/canonical-variant-evidence.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20261015113000_allow_schema_org_inverse_variant_evidence.sql", import.meta.url), "utf8");

const emittedSources = [...parser.matchAll(/evidenceSource:\s*"(schema_org_[a-z_]+|amazon_variation_asin_map)"/g)]
  .map((match) => match[1]);
const allowedSources = [...migration.matchAll(/'((?:schema_org_[a-z_]+)|(?:amazon_variation_asin_map))'/g)]
  .map((match) => match[1]);

assert.ok(emittedSources.includes("schema_org_product_is_variant_of"), "parser must continue to expose inverse child-to-parent evidence");
for (const source of new Set(emittedSources)) {
  assert.ok(allowedSources.includes(source), `database evidence_source constraint must allow parser source: ${source}`);
}
console.log("Canonical variant evidence-source constraint: all parser evidence values are permitted");
