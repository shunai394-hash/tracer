import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile("supabase/migrations/20261014100000_cj_supplier_first_draft_catalog.sql", "utf8");
const helper = await readFile("lib/suppliers/stage-cj-supplier-first-catalog.ts", "utf8");
const ingestion = await readFile("lib/suppliers/persist-cj-internal-supply.ts", "utf8");

assert.match(migration, /stage_cj_supplier_first_catalog_draft/);
assert.match(migration, /v_product\.source_name <> 'cj' or v_variant\.source_name <> 'cj'/);
assert.match(migration, /supplier_evidence_stale/);
assert.match(migration, /supplier_scoped_identity_mismatch/);
assert.match(migration, /'identity_scope','supplier_variant'/);
assert.match(migration, /'global_barcode_verified',false/);
assert.match(migration, /'automated_order_creation_verified',false/);
assert.match(migration, /'demand_evidence_status','not_observed'/);
assert.match(migration, /status='draft'/);
assert.match(migration, /orderable=false/);
assert.match(migration, /bestseller_id=null/);
assert.doesNotMatch(migration, /marketplace_bestseller_variants/);

assert.match(helper, /stage_cj_supplier_first_catalog_draft/);
assert.match(helper, /variant_product_scope_mismatch/);
assert.match(helper, /not_cj_source/);
assert.match(ingestion, /stageCjSupplierFirstDraft/);
assert.match(ingestion, /supplier_first_catalog_stage: catalogStage/);

console.log("CJ supplier-first catalog draft contract: passed");
