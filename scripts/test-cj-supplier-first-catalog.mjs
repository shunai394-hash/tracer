import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile("supabase/migrations/20261014100000_cj_supplier_first_draft_catalog.sql", "utf8");
const helper = await readFile("lib/suppliers/stage-cj-supplier-first-catalog.ts", "utf8");
const ingestion = await readFile("lib/suppliers/persist-cj-internal-supply.ts", "utf8");
const discovery = await readFile("lib/suppliers/discover-cj-supply.ts", "utf8");

const includes = (source, fragment, label = fragment) => assert.ok(source.includes(fragment), `missing contract: ${label}`);
const excludes = (source, fragment, label = fragment) => assert.ok(!source.includes(fragment), `unexpected contract: ${label}`);

includes(migration, "stage_cj_supplier_first_catalog_draft");
includes(migration, "v_product.source_name <> 'cj' or v_variant.source_name <> 'cj'");
includes(migration, "supplier_evidence_stale");
includes(migration, "Only supplier fetch timestamps prove freshness");
includes(migration, "v_product.fetched_at is null");
includes(migration, "v_variant.fetched_at is null");
excludes(migration, "coalesce(v_product.fetched_at, v_product.updated_at)");
excludes(migration, "coalesce(v_variant.fetched_at, v_variant.updated_at)");
includes(migration, "v_product.generation is distinct from p_expected_product_generation");
includes(migration, "v_variant.generation is distinct from p_expected_variant_generation");
includes(migration, "supplier_scoped_identity_mismatch");
includes(migration, "'identity_scope','supplier_variant'");
includes(migration, "'global_barcode_verified',false");
includes(migration, "v_barcode := null");
includes(migration, "'automated_order_creation_verified',false");
includes(migration, "'demand_evidence_status','not_observed'");
includes(migration, "status='draft'");
includes(migration, "orderable=false");
includes(migration, "bestseller_id=null");
excludes(migration, "marketplace_bestseller_variants");

includes(helper, "stage_cj_supplier_first_catalog_draft");
includes(helper, "variant_product_scope_mismatch");
includes(helper, "not_cj_source");
includes(helper, "product.generation == null || variant.generation == null");
includes(ingestion, "stageCjSupplierFirstDraft");
includes(ingestion, "supplier_first_catalog_stage: catalogStage");

includes(discovery, "rejectedReasons: cursor.rejectedReasons");
includes(discovery, "quotaBlocked: cursor.quotaBlocked");
includes(discovery, "const rejectedReasons = items.reduce");
includes(discovery, "const status = cursor.quotaBlocked");
includes(discovery, 'cursor.verified > 0 ? "partial" : "failed"');
includes(discovery, "status,\n      started_at: now");

console.log("CJ supplier-first catalog draft contract: passed");
