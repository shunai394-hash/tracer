// Static wiring guards for the CJ -> internal supply ingestion path.
// Run: node scripts/verify-cj-internal-supply-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const discovery = readFileSync("lib/suppliers/discover-cj-supply.ts", "utf8");
const marketCollector = readFileSync("lib/market/collect-bestsellers.ts", "utf8");
const ingest = readFileSync("lib/suppliers/persist-cj-internal-supply.ts", "utf8");
const catalogSync = readFileSync("lib/suppliers/sync-tracer-catalog.ts", "utf8");
const identity = readFileSync("lib/market/identifiers.ts", "utf8");
const auditMigration = readFileSync("supabase/migrations/20261010150000_tracer_internal_supply_ingestion_audit.sql", "utf8");

assert.match(discovery, /import \{ persistCjInternalSupplyCandidate \} from "@\/lib\/suppliers\/persist-cj-internal-supply"/);
assert.equal((discovery.match(/persistCjInternalSupplyCandidate\(/g) ?? []).length, 2,
  "both seeded verification and fresh catalog discovery must feed the internal supply catalog");
assert.match(discovery, /internalSupplyIngested: Boolean\(internalSupply\)/);
assert.match(discovery, /"women handbag", "women crossbody bag", "women shoulder bag", "women tote bag"/,
  "new supply discovery must prioritize women's bags before beauty tools and hair accessories");
assert.match(discovery, /"beauty tools", "facial cleansing brush", "makeup brush cleaner", "makeup organizer"/,
  "beauty tools must follow women's bags in the supply query priority");
assert.match(discovery, /"hair styling tools", "hair clip women", "claw clip women"/,
  "hair accessories must be an explicit high-priority catalog segment");
assert.match(discovery, /Include every due supplier category/,
  "category priority must sort candidates, not exclude non-women's categories");
assert.match(discovery, /supply-first-catalog-cursor-v2/,
  "query-order changes must not reinterpret an old cursor index");
assert.match(discovery, /next_verification_at\.is\.null,next_verification_at\.lte/,
  "supplier verification queue must select only rows whose next verification is due");
assert.match(discovery, /order\("next_verification_at", \{ ascending: true, nullsFirst: true \}\)/,
  "due supplier rows must advance through the queue instead of being starved by inventory sorting");
assert.match(discovery, /let seededChecked = 0/,
  "failed seeded refreshes must count as attempts and not starve fresh catalog discovery");
assert.match(discovery, /seededChecked >= seededVerificationLimit/,
  "seeded verification must have a hard per-run attempt budget");
assert.match(marketCollector, /retryBrightDataWhenCanonicalVariantsMissing/,
  "Amazon detail fetches must retry Bright Data when direct HTML lacks JSON-LD");
assert.match(marketCollector, /hasAmazonVariantEvidence\(directHtml\)/,
  "a non-empty Amazon page without canonical child variants or an explicit variation-ASIN map must not suppress the Bright Data fallback");
assert.match(ingest, /sourceRef = `cj:\$\{args\.supplierProductId\}:\$\{args\.supplierVariantId\}`/,
  "source reference must be deterministic for the concrete supplier product+variant");
assert.match(ingest, /onConflict: "source_name,source_ref"/,
  "product writes must use the deterministic source key for retry/concurrency safety");
assert.match(ingest, /onConflict: "supply_product_id,variant_id"/,
  "variant writes must use the exact supplier variant key for retry/concurrency safety");
assert.match(ingest, /source_name: "cj"/, "CJ variants must carry their source namespace");
assert.match(ingest, /\.eq\("source_name", "cj"\)/, "variant ownership precheck must be supplier-scoped");
assert.match(ingest, /variant_id: args\.supplierVariantId/,
  "the exact supplier variant ID must be persisted separately from SKU/barcode");
assert.match(ingest, /normalizeIdentifier\("gtin", raw\)/,
  "invalid GTIN check digits must not become identity evidence");
assert.match(ingest, /const freshIds = validBarcodeIds\(args\.barcode\)/,
  "current barcode validation must remain separate from preserved identity evidence");
assert.match(ingest, /ids = Object\.values\(freshIds\)\.some\(Boolean\) \? freshIds : previousIds/,
  "a missing/invalid refresh must preserve prior verified IDs without mixing barcode values");
assert.match(ingest, /preserved_prior_valid_identifier/,
  "the audit payload must not overstate prior identity provenance");
assert.match(ingest, /productPayload\.gtin = ids\.gtin/);
assert.match(ingest, /productPayload\.jan = ids\.jan/);
assert.match(ingest, /productPayload\.ean = ids\.ean/);
assert.match(ingest, /productPayload\.upc = ids\.upc/);
assert.match(ingest, /productPayload\.metadata\.supplier_identifier_evidence_source = identifierEvidenceSource/);
assert.match(ingest, /active: false/,
  "the product must be quarantined before variant mutation");
assert.match(ingest, /orderable: false/,
  "supplier stock/freight alone must not enable automated purchasing");
assert.match(ingest, /identityLink = \{/,
  "a unique exact identifier match must be recorded separately from orderability");
assert.match(ingest, /from\("marketplace_bestseller_variants"\)/,
  "supplier identity must be compared against independently stored marketplace child variants");
assert.match(ingest, /marketplace_variant_evidence_id: String\(row\.id\)/,
  "verified links must persist the exact canonical child-variant evidence ID");
assert.match(ingest, /\["schema_org_product_group_has_variant", "amazon_variation_asin_map"\]\.includes\(String\(item\.row\.evidence_source\)\)/,
  "Schema.org child variants and explicit Amazon child-ASIN-map variants are eligible only after child barcode proof");
assert.match(catalogSync, /\["schema_org_product_group_has_variant", "amazon_variation_asin_map"\]\.includes\(String\(candidate\.canonical\.evidence_source\)\)/,
  "catalog sync must accept both supported canonical child-evidence sources after exact barcode matching");
assert.match(ingest, /const barcodeMethod = \["jan", "gtin", "ean", "upc"\]\.includes\(identity\.method\)/,
  "only exact barcode-family proof may establish supplier-to-child-variant identity");
assert.match(ingest, /automated_order_creation_verified: false/,
  "live stock/freight verification must not be represented as proof of automated ordering");
assert.match(ingest, /sku: null/,
  "supplier SKU is stored on the concrete variant to avoid collisions in the product-level unique SKU index");
const productPayload = ingest.split("const productPayload = {")[1]?.split("const existingProduct =")[0] ?? "";
assert.ok(productPayload.length > 0, "product payload must be inspectable");
assert.match(productPayload, /source_ref: sourceRef/);
assert.match(productPayload, /gtin: ids\.gtin/);
assert.match(productPayload, /jan: ids\.jan/);
assert.match(productPayload, /ean: ids\.ean/);
assert.match(productPayload, /upc: ids\.upc/);
assert.match(ingest, /sourceRef = `cj:\$\{args\.supplierProductId\}:\$\{args\.supplierVariantId\}`/,
  "product-level barcode fields are safe only because this product row is scoped to the exact supplier variant");
const variantPayload = ingest.split("const variantPayload = {")[1]?.split("// The full unique conflict target")[0] ?? "";
assert.ok(variantPayload.length > 0, "variant payload must be inspectable");
assert.match(variantPayload, /\.\.\.ids/, "valid barcode identifiers must remain attached to the concrete supplier variant");
assert.match(ingest, /cj_internal_supply_variant_already_owned_by_another_product/,
  "a supplier variant ID already owned by another internal product must be rejected");
assert.match(ingest, /internal_supply_ingestion_audit/,
  "an ingestion audit attempt must be made");
assert.match(ingest, /duplicate link does not match canonical child evidence/,
  "a unique conflict must not be reported as success unless the persisted identity evidence matches");
assert.match(ingest, /auditStatus: "written" \| "table_missing" \| "write_failed"/,
  "audit table absence must be distinguished from other audit write failures");
assert.match(ingest, /auditErrorCode === "42P01"/);
assert.match(ingest, /auditErrorCode === "PGRST205"/);
assert.match(auditMigration, /create table if not exists public\.internal_supply_ingestion_audit/);
assert.match(auditMigration, /grant all on public\.internal_supply_ingestion_audit to service_role/);
assert.match(identity, /function hasValidGs1CheckDigit/);

console.log("CJ internal-supply wiring checks passed.");
