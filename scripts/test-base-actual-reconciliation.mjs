import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideConfirmedPriceSync, publicationAgrees, reconcileBaseItems } from "../lib/channels/base-actual-reconciliation.ts";

const listing = {
  id: "listing-1",
  variantId: "variant-1",
  externalProductId: "100",
  externalVariantId: null,
  externalSku: "TRC-AAAAAAAAAAAAAAAAAAAAAAAA",
  sellingPrice: 3000,
  status: "published",
};

const result = reconcileBaseItems([
  { item_id: "100", identifier: "TRC-AAAAAAAAAAAAAAAAAAAAAAAA", title: "Linked", price: 3000, visible: 1 },
  { item_id: "200", identifier: "TRC-BBBBBBBBBBBBBBBBBBBBBBBB", title: "SKU only, no existing external ID", price: 1500, visible: 0 },
  { item_id: "300", identifier: null, title: "BASE only", price: 900, visible: 1 },
  { item_id: "400", identifier: "TRC-CCCCCCCCCCCCCCCCCCCCCCCC", title: "Ambiguous", price: 1000, visible: 1 },
  { item_id: "500", identifier: "TRC-DDDDDDDDDDDDDDDDDDDDDDDD", title: "SKU points to another BASE ID", price: 1200, visible: 1 },
], [
  listing,
  { ...listing, id: "listing-2", variantId: "variant-2", externalProductId: null, externalSku: "TRC-BBBBBBBBBBBBBBBBBBBBBBBB", sellingPrice: 2500, status: "published" },
  { ...listing, id: "listing-3", variantId: "variant-3", externalProductId: null, externalSku: "TRC-CCCCCCCCCCCCCCCCCCCCCCCC", sellingPrice: 1000, status: "hidden" },
  { ...listing, id: "listing-4", variantId: "variant-4", externalProductId: null, externalSku: "TRC-CCCCCCCCCCCCCCCCCCCCCCCC", sellingPrice: 1000, status: "hidden" },
  { ...listing, id: "listing-5", variantId: "variant-5", externalProductId: "900", externalSku: "TRC-DDDDDDDDDDDDDDDDDDDDDDDD", sellingPrice: 1200, status: "published" },
]);

assert.equal(result.summary.itemCount, 5);
assert.equal(result.items.length, result.rows.length);
assert.equal(result.summary.exactIdMatches, 1);
assert.equal(result.summary.exactSkuMatches, 1);
assert.equal(result.summary.idConflicts, 1);
assert.equal(result.summary.unmappedItems, 1);
assert.equal(result.summary.ambiguousItems, 1);
assert.equal(result.summary.missingSku, 1);
assert.equal(result.summary.priceMismatches, 1);
assert.equal(result.summary.publicationMismatches, 1);
assert.equal(result.items.find((item) => item.baseItemId === "300").mappingStatus, "unmapped");
assert.equal(result.items.find((item) => item.baseItemId === "200").publicationMatches, false);
const conflict = result.items.find((item) => item.baseItemId === "500");
assert.equal(conflict.mappingStatus, "id_conflict");
assert.equal(conflict.existingExternalProductId, "900");
assert.ok(conflict.discrepancyReasons.includes("base_item_id_conflict"));
assert.equal(conflict.tracerVariantId, null);
assert.equal(result.rows.find((row) => row.external_product_id === "500")?.variant_id, null);
assert.equal(result.rows.find((row) => row.external_product_id === "500")?.details.mappingStatus, "id_conflict");
assert.equal(publicationAgrees(true, "published"), true);
assert.equal(publicationAgrees(false, "published"), false);
assert.equal(publicationAgrees(null, "published"), null);

assert.deepEqual(decideConfirmedPriceSync({
  baseItemId: "100",
  baseIdentifier: "TRC-AAAAAAAAAAAAAAAAAAAAAAAA",
  basePrice: 2500,
  listings: [listing],
}), { ok: true, listingId: "listing-1", canonicalPrice: 3000 });
assert.deepEqual(decideConfirmedPriceSync({
  baseItemId: "100",
  baseIdentifier: "TRC-AAAAAAAAAAAAAAAAAAAAAAAA",
  basePrice: 2500,
  listings: [
    listing,
    { ...listing, id: "listing-duplicate-sku", variantId: "variant-duplicate", externalProductId: "200" },
  ],
}), { ok: true, listingId: "listing-1", canonicalPrice: 3000 });
assert.equal(decideConfirmedPriceSync({
  baseItemId: "200",
  baseIdentifier: "TRC-BBBBBBBBBBBBBBBBBBBBBBBB",
  basePrice: 1500,
  listings: [listing],
}).ok, false);
assert.deepEqual(decideConfirmedPriceSync({
  baseItemId: "501",
  baseIdentifier: "TRC-DDDDDDDDDDDDDDDDDDDDDDDD",
  basePrice: 1200,
  listings: [{
    ...listing,
    id: "listing-conflict",
    externalProductId: "900",
    externalSku: "TRC-DDDDDDDDDDDDDDDDDDDDDDDD",
    sellingPrice: 2500,
  }],
}), { ok: true, listingId: "listing-conflict", canonicalPrice: 2500 });
assert.equal(decideConfirmedPriceSync({
  baseItemId: "100",
  baseIdentifier: "TRC-OTHER",
  basePrice: 2500,
  listings: [listing],
}).reason, "sku_not_exact");

const route = readFileSync(new URL("../app/api/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
const priceRoute = readFileSync(new URL("../app/api/channels/base/confirmed-price-sync/route.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261018010000_channel_price_reconciliation_audit.sql", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/base-actual-item-reconciliation-audit.yml", import.meta.url), "utf8");

assert.match(route, /auditWriteErrorCode/);
assert.match(route, /from\("commerce_events"\)/);
assert.match(route, /items: reconciled\.items/);
assert.match(route, /Walking them/);
assert.doesNotMatch(route, /for \(const row of batch\)/);
assert.match(route, /range\(from, from \+ 999\)/);
assert.doesNotMatch(route, /\.delete\(|editBaseItem\(|createBaseItem\(/);
const grant = readFileSync(new URL("../supabase/migrations/20261018020000_channel_price_reconciliation_audit_grants.sql", import.meta.url), "utf8");
assert.match(grant, /42501/);
assert.match(grant, /disable row level security/);
assert.match(grant, /grant all privileges on table public\.channel_price_reconciliation_audit to service_role/);
assert.match(priceRoute, /body\.apply === true/);
assert.match(priceRoute, /visible,/);
assert.match(priceRoute, /stock,/);
assert.doesNotMatch(priceRoute, /visible:\s*true/);
assert.doesNotMatch(priceRoute, /\.delete\(/);
assert.match(migration, /channel_price_reconciliation_audit/);
assert.match(migration, /external_product_id text/);
assert.match(migration, /details jsonb/);
assert.match(workflow, /auditWriteErrorCode/);
assert.match(workflow, /itemCount !== report\.auditRowsWritten/);
assert.match(workflow, /evidenceComplete/);

console.log("BASE actual-item reconciliation evidence: ok");
