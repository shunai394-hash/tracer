import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { classifyUnmappedBaseItem } from "../lib/channels/base-unmapped-classify.ts";
import { reconcileShopifyCatalog } from "../lib/shopify/catalog-reconcile.ts";
import { localizeProductTitle } from "../lib/intelligence/japanese-product.ts";
import { canonicalCommerceSku, planShopifyParityRepair } from "../lib/shopify/parity-repair-plan.ts";
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
    nodes: [node(1, { totalInventory: 3 }), node(2, { variants: [{ id: "gid://shopify/ProductVariant/2", sku: "TRC-000000000000000000000002", price: "900" }] }), node(3, { vendor: "Other", variants: [{ id: "x", sku: "ABC", price: "1" }] }), node(4, { status: "DRAFT" }), node(5, { variants: [{ id: "y", sku: "TRC-000000000000000000000001", price: "1000" }] })],
    scanComplete: true,
    commerceRows: [commerceRow(1), commerceRow(2), commerceRow(9)],
    legacyRows: [{ id: "l1", shopify_product_id: "4" }],
    probeVariantIds: ["v1", "v404"],
  });
  assert.equal(result.scan.precision, "EXACT");
  assert.deepEqual(result.store, { total: 5, active: 4, draft: 1, archived: 0, liveOnOnlineStore: 4, inStock: 1, activeInStock: 1 });
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
  assert.match(shopifyRoute, /nextShopifyVendorPage\(/);
  assert.match(shopifyRoute, /products\(first: 100, after: \$after, sortKey: ID\)/);
  assert.match(shopifyRoute, /scanComplete: vendorScanComplete/);
  assert.doesNotMatch(shopifyRoute, /\.(insert|update|upsert|delete)\(/);
});
check("BASE identity repair evaluates the whole snapshot; limit only bounds writes", () => {
  assert.doesNotMatch(repairRoute, /snapshot\.items\.slice\(0, limit\)/);
  assert.match(repairRoute, /repairable_deferred_by_limit/);
});
check("BASE scans confirm the end at the cap and reject duplicate or missing ids", () => {
  assert.match(baseLib, /items\?limit=1&offset=\$\{offset\}/);
  assert.match(baseLib, /result\.items\.duplicateItemCount \+= 1;/);
  assert.match(baseLib, /BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE/);
});
check("status and funnel share the NEWFIND outcome rule; reconciliation pages channel_listings", () => {
  assert.match(statusRoute, /tallyNewfindDeliveries\(rows\)/);
  assert.match(funnel, /newfindDeliveryOutcome\(delivery\) === "delivered"/);
  assert.match(reconciliationRoute, /\.range\(from, from \+ 999\)/);
  assert.match(reconciliationRoute, /classifyUnmappedBaseItem\(/);
  assert.doesNotMatch(reconciliationRoute, /\.(insert|update|upsert|delete)\(/);
  assert.match(baseWorkflow, /candidate\.schemaVersion >= 3/);
});

const baseOrders = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
check("a paid BASE line for an unlinked item is recorded for review, never silently dropped or procured", () => {
  const unlinked = baseOrders.slice(baseOrders.indexOf("if (!listing) {"), baseOrders.indexOf("const { data: price"));
  assert.match(unlinked, /result\.unmappedItems\+\+/);
  assert.match(unlinked, /event_type: BASE_UNMAPPED_ORDER_ITEM_EVENT/);
  assert.match(unlinked, /status: "needs_review"/);
  assert.doesNotMatch(unlinked, /ingestPaidOrder|address|first_name|tel/);
  assert.match(baseOrders, /const healthy = result\.failed === 0 && result\.unmappedItems === 0;/);
  assert.match(statusRoute, /unmappedItemsNeedingReview: baseUnmappedOrderItems/);
});

check("Shopify parity repair drafts only id/SKU-matched products and never acts on unmatched ones", () => {
  const v1 = "11111111-2222-4333-8444-555555555555";
  const v2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const v3 = "cccccccc-dddd-4eee-8fff-000000000000";
  const legacy = "99999999-8888-4777-8666-555555555555";
  assert.equal(canonicalCommerceSku(v1), "TRC-111111112222433384445555");
  const live = (id, sku, extra = {}) => ({ id: "gid://shopify/Product/" + id, handle: "h" + id, status: "ACTIVE", vendor: "TRACER", publishedOnPublication: true, variants: [{ id: "v" + id, sku }], ...extra });
  const decisions = planShopifyParityRepair({
    nodes: [
      live(1, canonicalCommerceSku(v1)),
      live(2, canonicalCommerceSku(v1)),
      live(3, canonicalCommerceSku(v2)),
      live(4, "TRC-" + legacy),
      live(5, "UNRELATED-SKU"),
      live(8, canonicalCommerceSku(v3)),
      live(6, canonicalCommerceSku(v1), { status: "DRAFT" }),
      live(7, canonicalCommerceSku(v1), { vendor: "Other" }),
    ],
    commerceRows: [
      { id: "c1", variant_id: v1, external_product_id: "1", external_sku: null, status: "published" },
      { id: "c2", variant_id: v2, external_product_id: null, external_sku: null, status: "error", last_error: "shopify_handle_sku_mismatch" },
      { id: "c3", variant_id: v3, external_product_id: "8", external_sku: null, status: "pending" },
    ],
    legacyRows: [{ id: legacy, published: false, shopify_product_id: null }],
  });
  const by = Object.fromEntries(decisions.map((d) => [d.shopifyProductId.split("/").pop(), d]));
  assert.deepEqual(Object.keys(by).sort(), ["1", "2", "3", "4", "5", "8"]);
  // Pending rows are being republished by the publisher; never draft them.
  assert.equal(by[8].action, "keep");
  assert.equal(by[1].action, "keep");
  assert.equal(by[2].action, "draft");
  assert.equal(by[2].reason, "duplicate_sku_of_linked_product");
  assert.equal(by[3].action, "draft");
  assert.equal(by[3].channelListingId, "c2");
  assert.equal(by[4].action, "draft");
  assert.equal(by[4].reason, "legacy_listing_unpublished");
  assert.equal(by[5].action, "manual_review");
  assert.equal(decisions.some((d) => d.action === "delete"), false);
  const route = readFileSync(new URL("../app/api/admin/shopify/parity-repair/route.ts", import.meta.url), "utf8");
  assert.match(route, /apply_requires_product_ids_from_dry_run/);
  assert.match(route, /shopify_scan_incomplete/);
  assert.match(route, /status: "DRAFT"/);
  assert.doesNotMatch(route, /productDelete|productArchive|status: "ARCHIVED"/);
});

check("source-grounded titles separate products that shared one generic name", () => {
  const brush = [
    "4 In 1 Electric Makeup Brush Cleaner USB Powered Automatic Brush Blender Machine With Timer Digital Display Cleaning Drying UV Disinfection Brush Storage",
    "Makeup Brush Cleaner Automatic Rotating Makeup Brush Cleaner USB Portable Electric Cosmetic Makeup Brush Rotary Washing Machine",
    "Foldable Silicone Makeup Brush Cleaner Bowl, Reusable Makeup Brush Washing Tool",
    "Professional Silicone Makeup Brush Cleaner Mat With Suction Cups - Portable Washing Pad, 2 Pack",
    "Puff Cleaner Makeup Brush Cleaner Liquid Makeup Tools Beauty Egg Cushion Sponge Clean No Residue",
    "Original Makeup Brush Cleaner  Dryer Make Up Cleaning Tools",
  ].map((title) => localizeProductTitle(title));
  assert.equal(new Set(brush).size, brush.length);
  assert.ok(brush.every((title) => title && title !== "メイクブラシ収納・お手入れ用品"));
  // A dryer without an electric claim in the source must not be called electric.
  assert.equal(localizeProductTitle("Original Makeup Brush Cleaner  Dryer Make Up Cleaning Tools"), "乾燥機能付き メイクブラシクリーナー");
  assert.equal(localizeProductTitle("Women Hair Scrunchies Vintage Velvet Solid Color Hair Band For Girls"), "ベルベット シュシュ");
  assert.equal(localizeProductTitle("Retro Patchwork Shoulder Bag For Women"), "パッチワーク レトロショルダーバッグ");
  const route = readFileSync(new URL("../app/api/admin/commerce/title-refresh/route.ts", import.meta.url), "utf8");
  assert.match(route, /apply_requires_product_ids_from_dry_run/);
  assert.match(route, /titleCount\.get\(current\) \?\? 0\) < 2/);
  assert.doesNotMatch(route, /\.delete\(/);
  // Renames must never downgrade a descriptive title to a bare category label.
  assert.match(route, /GENERIC_TARGET_TITLES\.has\(next\)/);
  assert.match(route, /"レディース ショルダーバッグ"/);
});

console.log(`catalog reconciliation: ${cases} cases passed`);
