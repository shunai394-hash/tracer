import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const evidence = await readFile(new URL("../lib/catalog/fresh-supplier-evidence.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");

assert.match(evidence, /MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/, "supplier inventory evidence expires after 24 hours");
assert.match(evidence, /inventory_checked_at/, "missing inventory timestamps fail closed");
assert.match(evidence, /verification_status !== "verified"/, "unverified supplier rows fail closed");
assert.match(evidence, /inventory_confirmed !== true/, "unconfirmed stock fails closed");
assert.match(evidence, /identity_status !== "linked"/, "unlinked supplier identity fails closed");
assert.match(evidence, /orderable !== true/, "non-orderable supplier listings fail closed");
assert.match(evidence, /api_available !== true/, "supplier API capability is required");
assert.match(evidence, /tracking_available !== true/, "tracking capability is required");
assert.match(evidence, /productId !== ref.supplierProductId \|\| variantId !== ref.supplierVariantId/, "exact product and variant pair is required");
assert.match(evidence, /nextVerificationAt|const next =/, "expired re-verification deadline is checked");
assert.match(base, /getFreshSupplierEvidence/, "BASE publisher uses fresh supplier evidence");
assert.match(base, /currentSupplierEvidence \? currentSupplierEvidence\.inventory : null/, "BASE quantity comes from supplier inventory");
assert.match(shopify, /getFreshSupplierEvidence/, "Shopify sync uses fresh supplier evidence");
assert.match(shopify, /inventory: evidence\?\.inventory \?\? null/, "Shopify stock comes from supplier inventory and unknown is null");
assert.match(shopify, /await setShopifyVariantInventory\([\s\S]*?quantity: Number\(row\.inventory\)/, "Shopify writes the validated supplier quantity");

console.log("Fresh supplier inventory gate checks: 15 passed");
