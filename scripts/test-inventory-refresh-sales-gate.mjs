import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasDurableSalesTestGate } from "../lib/suppliers/inventory-refresh-gate.ts";
import { isStripePaymentConfirmed } from "../lib/payments/stripe/payment-confirmation-policy.ts";

const marker = "sales_test_gate_passed";
const cases = [
  { name: "marker_present", input: [marker, "other"], expected: true },
  { name: "empty_reasons", input: [], expected: false },
  { name: "missing_reasons", input: null, expected: false },
  { name: "non_array_reasons", input: marker, expected: false },
  { name: "marker_removed_after_cost_change", input: ["other"], expected: false },
  { name: "wrong_marker", input: ["sales_test_gate_pending"], expected: false },
];
for (const item of cases) {
  assert.equal(hasDurableSalesTestGate(item.input), item.expected, item.name);
}
const paymentStatusCases = [
  ["paid", true],
  ["unpaid", false],
  ["no_payment_required", false],
  [null, false],
  [undefined, false],
  ["Paid", false],
];
for (const [status, expected] of paymentStatusCases) {
  assert.equal(isStripePaymentConfirmed(status), expected, `Stripe payment status ${String(status)}`);
}
const persistence = readFileSync(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
assert.match(persistence, /price_checked_at:\s*null/, "cached or caller-provided CJ cost must not be stamped as a fresh price observation");
assert.doesNotMatch(persistence, /price_checked_at:\s*Number\.isFinite\(args\.cost\)/, "price freshness must not be inferred from cost validity alone");

const baseOrders = readFileSync(new URL("../lib/channels/base-orders.ts", import.meta.url), "utf8");
assert.match(baseOrders, /function assertUniqueBaseItemMappings[\\s\\S]*base_item_mapping_ambiguous/, "ambiguous BASE item IDs must fail closed instead of selecting an arbitrary listing");
assert.equal((baseOrders.match(/assertUniqueBaseItemMappings\\(listings\\)/g) ?? []).length, 2, "both BASE order repair and initial import must reject ambiguous item mappings");
const refreshRoute = readFileSync(new URL("../app/api/cron/inventory-refresh/route.ts", import.meta.url), "utf8");
assert.match(refreshRoute, /pipeline_reason:\s*"base_inventory_sync_failed"/, "BASE sync failures must be durably classified");
assert.match(refreshRoute, /published:\s*false,\s*orderable:\s*false/, "BASE sync failures must fail closed locally");
assert.match(refreshRoute, /visible:\s*false/, "BASE sync failures must attempt to hide the remote listing");
assert.match(refreshRoute, /hide retry failed:/, "failed BASE hide attempts must be recorded");
assert.match(refreshRoute, /from\("supplier_listings"\)[\s\S]{0,180}update\(\{ orderable: false, fetched_at: now \}\)/, "BASE sync failures must also block supplier-side eligibility");
assert.match(refreshRoute, /orderable:\s*orderable\s*&&\s*!deferBaseEligibility/, "BASE-backed listings must remain locally non-orderable while BASE sync is pending");
assert.match(refreshRoute, /restoreListingError[\s\S]{0,400}update\(\{ orderable, base_last_error: null \}\)/, "listing eligibility may be restored only after BASE sync succeeds and zero stock remains blocked");
assert.match(refreshRoute, /restoreSupplierError[\s\S]{0,400}update\(\{ orderable, fetched_at: now \}\)/, "supplier eligibility may be restored only after BASE sync succeeds and zero stock remains blocked");


const orosyImport = readFileSync(new URL("../app/api/cron/orosy-bulk-import/route.ts", import.meta.url), "utf8");
assert.match(orosyImport, /getOrosyShippingQuote/, "Orosy bulk import records a product-level quote for diagnostics");
assert.match(orosyImport, /variation\.currency\?\.trim\(\)\.toUpperCase\(\) !== "JPY"/, "JPY selling-price math requires an explicitly confirmed JPY supplier cost");
assert.match(orosyImport, /product-level quote is not sufficient evidence for this[\s\S]*exact variant/, "product-level shipping must not be promoted to variant-level evidence");
assert.match(orosyImport, /shipping_status:\s*"unknown"/, "product-level quote must not verify variant-level shipping");
assert.match(orosyImport, /shipping_checked_at:\s*null/, "variant-level shipping freshness must remain unset until exact-variant quote exists");
assert.match(orosyImport, /orderable:\s*false/, "Orosy import must not claim autonomous ordering while order creation/payment are unsupported");
const orosyAdapter = readFileSync(new URL("../lib/procurement/orosy-adapter.ts", import.meta.url), "utf8");
assert.match(orosyAdapter, /amount:\s*null,[\s\S]{0,100}currency:\s*null,[\s\S]{0,100}available:\s*null/, "indicative Orosy shipping must not be treated as confirmed landed cost");
assert.doesNotMatch(orosyAdapter, /currency:\s*[^,\n]*\?\?[^,\n]*"JPY"/, "missing supplier currency must not be inferred as JPY, including chained fallbacks");
assert.match(orosyImport, /tracking_available:\s*null/, "tracking must not be claimed without order lifecycle evidence");
assert.match(orosyImport, /contribution_profit:\s*null[\s\S]*contribution_margin:\s*null/, "profitability must remain unset until landed cost and Sales Test Gate are established");
assert.doesNotMatch(orosyImport, /selection_reasons:\s*\[[^\]]*"ORDERABLE"/, "candidate import must not stamp the orderable marker");


assert.doesNotMatch(orosyImport, /syncPublishedListingsToShopify/, "staging import must not trigger unrelated Shopify production sync");
assert.match(orosyImport, /staging_only_no_shopify_sync/, "import endpoint must explicitly report staging-only behavior");


const checkoutRoute = readFileSync(new URL("../app/api/shop/orders/route.ts", import.meta.url), "utf8");
assert.match(checkoutRoute, /currencies\.size !== 1 \|\| !currencies\.has\("JPY"\)/, "card checkout must reject missing, mixed, or non-JPY currency instead of defaulting to USD");
assert.doesNotMatch(checkoutRoute, /orderItems\[0\]\.currency \?\? ["']USD["']/, "card checkout must not silently default an unknown currency to USD");
assert.match(checkoutRoute, /Number\.isSafeInteger\(Number\(item\.qty\)\)[\s\S]{0,220}Number\.isFinite\(Number\(item\.unit_price\)\)/, "card checkout must reject invalid quantities and prices before creating a Stripe session");


const stripeWebhook = readFileSync(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8");
assert.match(stripeWebhook, /constructStripeEvent\(rawBody, signature\)/, "Stripe webhook must verify the signed raw request body");
assert.match(stripeWebhook, /isStripePaymentConfirmed\(session\.payment_status\)/, "Stripe webhook must use the tested payment confirmation policy");
assert.match(stripeWebhook, /if \(paymentUpdateError\) \{\s*throw new Error\(paymentUpdateError\.message\);\s*\}/, "payment confirmation persistence errors must fail the webhook");
assert.match(stripeWebhook, /createDropshipPurchaseOrdersForShopOrder\(shopOrderId\)/, "fulfillment creation must follow the confirmed payment path");
assert.match(stripeWebhook, /stripe_event_id[\s\S]{0,260}processed: false/, "webhook events must be durably claimed before processing");
assert.match(stripeWebhook, /processed: !error/, "failed webhook processing must remain retryable rather than marked processed");
const dropship = readFileSync(new URL("../lib/ordering/dropship.ts", import.meta.url), "utf8");
assert.match(dropship, /if \(String\(order\.payment_status\) !== "paid"\)[\s\S]{0,220}shop_order_payment_not_confirmed/, "supplier PO creation must reject orders whose payment is not confirmed");
assert.match(dropship, /idempotency_key: idempotencyKey/, "supplier PO creation must use a per-line idempotency key");

console.log(`Inventory refresh sales-gate invariant: ${cases.length} cases passed; supplier price freshness: 2 assertions; BASE fail-closed: 8 assertions; Orosy import safety: 10 assertions`);
