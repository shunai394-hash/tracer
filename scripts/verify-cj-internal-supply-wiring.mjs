// Static wiring guards for the CJ -> internal supply ingestion path.
// Run: node scripts/verify-cj-internal-supply-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const discovery = readFileSync("lib/suppliers/discover-cj-supply.ts", "utf8");
const ingest = readFileSync("lib/suppliers/persist-cj-internal-supply.ts", "utf8");
const identity = readFileSync("lib/market/identifiers.ts", "utf8");

assert.match(discovery, /import \{ persistCjInternalSupplyCandidate \} from "@\/lib\/suppliers\/persist-cj-internal-supply"/);
assert.equal((discovery.match(/persistCjInternalSupplyCandidate\(/g) ?? []).length, 2,
  "both seeded verification and fresh catalog discovery must feed the internal supply catalog");
assert.match(discovery, /internalSupplyIngested: Boolean\(internalSupply\)/);
assert.match(ingest, /sourceRef = `cj:\$\{args\.supplierProductId\}:\$\{args\.supplierVariantId\}`/,
  "source reference must be deterministic for the concrete supplier product+variant");
assert.match(ingest, /variant_id: args\.supplierVariantId/,
  "the exact supplier variant ID must be persisted separately from SKU/barcode");
assert.match(ingest, /normalizeIdentifier\("gtin", raw\)/,
  "invalid GTIN check digits must not become identity evidence");
assert.match(ingest, /active: false/,
  "the product must be quarantined before variant mutation");
assert.match(ingest, /orderable: false/,
  "supplier stock/freight alone must not enable automated purchasing");
assert.match(ingest, /identityLink = \{/,
  "a unique exact identifier match must be recorded separately from orderability");
assert.match(ingest, /automated_order_creation_verified: false/,
  "live stock/freight verification must not be represented as proof of automated ordering");
assert.match(ingest, /internal_supply_ingestion_audit/,
  "an ingestion audit attempt must be made");
assert.match(identity, /function hasValidGs1CheckDigit/);

console.log("CJ internal-supply wiring checks passed.");
