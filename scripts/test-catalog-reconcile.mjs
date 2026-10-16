import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyUnmappedBaseItem } from "../lib/channels/base-unmapped-classify.ts";
import { reconcileShopifyCatalog } from "../lib/shopify/catalog-reconcile.ts";
import { newfindDeliveryOutcome, tallyNewfindDeliveries } from "../lib/integration/newfind-delivery-state.ts";

let cases = 0;
const check = (name, fn) => { fn(); cases += 1; };
const none = { stableMatch: null, supplierIdentifierMatches: [], titleMatches: [] };
const legacyId = "TRC-11111111-1111-4111-8111-111111111111";
const commerceSku = "TRC-0123456789abcdef01234567";

check("commerce SKU: repairable only when the matched row has no BASE id", () => {
  assert.deepEqual(classifyUnmappedBaseItem({ ...none, identifier: commerceSku, stableMatch: { listingId: "a", existingBaseItemId: null } }), { category: "commerce_sku_unlinked_repairable", safeLinkListingId: "a" });
  assert.deepEqual(classifyUnmappedBaseItem({ ...none, identifier: commerceSku, stableMatch: { listingId: "a", existingBaseItemId: "999" } }), { category: "commerce_sku_duplicate_of_linked_item", safeLinkListingId: null });
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: commerceSku }).category, "commerce_sku_unknown");
});
check("legacy TRC-uuid: missing rows and conflicts are never linked", () => {
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: legacyId }).category, "legacy_uuid_listing_missing");
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: legacyId, stableMatch: { listingId: "b", existingBaseItemId: 5 } }).safeLinkListingId, null);
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: legacyId, stableMatch: { listingId: "b", existingBaseItemId: null } }).safeLinkListingId, "b");
});
check("supplier ids and titles are evidence only, never a safe link", () => {
  const one = [{ listingId: "c", existingBaseItemId: null }];
  assert.deepEqual(classifyUnmappedBaseItem({ ...none, identifier: "123", supplierIdentifierMatches: one }), { category: "supplier_identifier_unique", safeLinkListingId: null });
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: "123", supplierIdentifierMatches: [...one, ...one] }).category, "supplier_identifier_ambiguous");
  assert.deepEqual(classifyUnmappedBaseItem({ ...none, identifier: null, titleMatches: one }), { category: "title_unique_unlinked_candidate", safeLinkListingId: null });
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: null, titleMatches: [{ listingId: "d", existingBaseItemId: "1" }] }).category, "title_duplicate_of_linked_item");
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: null, titleMatches: [{ listingId: "d", existingBaseItemId: "1" }, { listingId: "e", existingBaseItemId: null }] }).category, "title_ambiguous");
  assert.equal(classifyUnmappedBaseItem({ ...none, identifier: "" }).category, "no_evidence");
});

const node = (n, patch = {}) => ({
  id: `gid://shopify/Product/${n}`, handle: `h${n}`, status: "ACTIVE", vendor: "TRACER", publishedOnPublication: true,
  variants: [{ id: `gid://shopify/ProductVariant/${n}`, sku: `TRC-${String(n).padStart(24, "0")}`, price: "1000" }], ...patch,
});
const commerceRow = (n, patch = {}) => ({
  variant_id: `v${n}`, external_product_id: `gid://shopify/Product/${n}`, external_variant_id: `gid://shopify/ProductVariant/${n}`,
  external_sku: `TRC-${String(n).padStart(24, "0")}`, status: "published", selling_price: 1000, ...patch,
});
check("Shopify counts keep store, vendor, commerce and legacy populations apart", () => {
  const result = reconcileShopifyCatalog({
    nodes: [node(1), node(2, { variants: [{ id: "gid://shopify/ProductVariant/2", sku: "TRC-000000000000000000000002", price: "900" }] }), node(3, { vendor: "Other", variants: [{ id: "x", sku: "ABC", price: "1" }] }), node(4, { status: "DRAFT" }), node(5, { variants: [{ id: "y", sku: "TRC-000000000000000000000001", price: "1000" }] })],
    scanComplete: true,
    commerceRows: [commerceRow(1), commerceRow(2), commerceRow(9)],
    legacyRows: [{ id: "l1", shopify_product_id: "4" }],
    probeVariantIds: ["v1", "v404"],
  });
  assert.equal(result.scan.precision, "EXACT");
  assert.deepEqual(result.store, { total: 5, active: 4, draft: 1, archived: 0, liveOnOnlineStore: 4 });
  assert.deepEqual(result.tracerVendor, { total: 4, active: 3, live: 3 });
  assert.equal(result.commerceChannelListings.verified, 1);
  assert.equal(result.commerceChannelListings.priceMismatch, 1);
  assert.equal(result.commerceChannelListings.missingInShopify, 1);
  assert.equal(result.legacyShopListings.existsInShopify, 1);
  assert.equal(result.unlinkedShopifyProducts.total, 2);
  assert.equal(result.unlinkedShopifyProducts.byKind.duplicate_of_commerce_sku.total, 1);
  assert.equal(result.unlinkedShopifyProducts.byKind.non_tracer_product.total, 1);
  assert.equal(result.duplicateSkuGroups, 1);
  assert.equal(result.variantProbes[0].shopifyProductsWithSku, 2);
  assert.equal(result.variantProbes[1].inDb, false);
});
check("a partial Shopify scan is never labelled EXACT", () => {
  assert.equal(reconcileShopifyCatalog({ nodes: [node(1)], scanComplete: false, commerceRows: [], legacyRows: [] }).scan.precision, "PARTIAL");
});

check("NEWFIND: delivered requires the receiver ACK; one definition for every count", () => {
  assert.equal(newfindDeliveryOutcome({ status: "processed", ack_status: "processed" }), "delivered");
  assert.equal(newfindDeliveryOutcome({ status: "processed", ack_status: "duplicate" }), "delivered");
  assert.equal(newfindDeliveryOutcome({ status: "processed", ack_status: null }), "status_without_ack");
  assert.equal(newfindDeliveryOutcome({ status: "sent", ack_status: "queued" }), "open");
  assert.deepEqual(tallyNewfindDeliveries([{ status: "processed", ack_status: "processed" }, { status: "failed" }, { status: "pending" }, { status: "withdrawn" }]),
    { total: 4, delivered: 1, failed: 1, open: 1, withdrawn: 1, status_without_ack: 0 });
});

const [shopifyRoute, repairRoute, baseLib, statusRoute, funnel, reconciliationRoute, baseWorkflow] = await Promise.all([
  "../app/api/admin/shopify/reconcile/route.ts",
  "../app/api/channels/base/identity-repair/route.ts",
  "../lib/channels/base.ts",
  "../app/api/admin/commerce/status/route.ts",
  "../app/api/intelligence/e2e-funnel/route.ts",
  "../app/api/admin/channels/base/reconciliation/route.ts",
  "../.github/workflows/base-product-backup.yml",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
check("Shopify reconcile scans to the last page instead of stopping at 800", () => {
  assert.doesNotMatch(shopifyRoute, /page < 8;/);
  assert.match(shopifyRoute, /if \(!data\.products\.pageInfo\.hasNextPage\) \{ scanComplete = true; break; \}/);
  assert.doesNotMatch(shopifyRoute, /\.(insert|update|upsert|delete)\(/);
});
check("BASE identity repair evaluates the whole snapshot; limit only bounds writes", () => {
  assert.doesNotMatch(repairRoute, /snapshot\.items\.slice\(0, limit\)/);
  assert.match(repairRoute, /repairable_deferred_by_limit/);
});
check("BASE scans confirm the end at the cap and reject duplicate or missing ids", () => {
  assert.match(baseLib, /items\?limit=1&offset=\$\{offset\}/);
  assert.match(baseLib, /BASE_ITEMS_ID_MISSING_OR_DUPLICATE/);
});
check("status and funnel share the NEWFIND outcome rule; reconciliation pages channel_listings", () => {
  assert.match(statusRoute, /tallyNewfindDeliveries\(rows\)/);
  assert.match(funnel, /newfindDeliveryOutcome\(delivery\) === "delivered"/);
  assert.match(reconciliationRoute, /\.range\(from, from \+ 999\)/);
  assert.match(reconciliationRoute, /classifyUnmappedBaseItem\(/);
  assert.doesNotMatch(reconciliationRoute, /\.(insert|update|upsert|delete)\(/);
  assert.match(baseWorkflow, /candidate\.schemaVersion >= 3/);
});

console.log(`catalog reconciliation: ${cases} cases passed`);
