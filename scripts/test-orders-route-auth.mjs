import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8");

assert.match(route, /import \{ requireAutomationAuth \} from "@\/lib\/security\/cron-auth"/);

const getStart = route.indexOf("export async function GET(request: Request)");
const getAuth = route.indexOf("const authError = await requireAutomationAuth(request);", getStart);
const getTry = route.indexOf("try {", getStart);
assert.ok(getStart >= 0 && getAuth > getStart && getAuth < getTry, "GET must authenticate before reading orders");

const postStart = route.indexOf("export async function POST(request: Request)");
const postAuth = route.indexOf("const authError = await requireAutomationAuth(request);", postStart);
const postTry = route.indexOf("try {", postStart);
assert.ok(postStart >= 0 && postAuth > postStart && postAuth < postTry, "POST must authenticate before parsing or writing");

const approvalGuard = route.indexOf("if (body.approved === true)", postStart);
const forbidden = route.indexOf("human_admin_approval_not_supported", approvalGuard);
const createOrder = route.indexOf("createPurchaseOrderFromRecommendation({", postStart);
assert.ok(approvalGuard > postStart && forbidden > approvalGuard, "unverified approval must fail closed");
assert.ok(createOrder > forbidden, "approval must be rejected before any purchase-order write");
assert.match(route.slice(createOrder, route.indexOf("});", createOrder)), /approved: false/);
assert.match(route.slice(createOrder, route.indexOf("});", createOrder)), /approvedBy: null/);
assert.doesNotMatch(route, /approvedBy: body\.approved === true \? "user"/);

const store = await readFile(new URL("../lib/ordering/store.ts", import.meta.url), "utf8");

assert.match(store, /idempotency_key:\s*idempotencyKey/, "recommendation order must persist an idempotency key");
assert.match(store, /\.eq\("idempotency_key", idempotencyKey\)/, "existing recommendation orders must be reused");
assert.match(store, /live_order:\s*false/, "internal record must not claim a live supplier order");
assert.match(store, /placed_at:\s*null/, "supplier-unconnected records must not have a placed timestamp");
assert.match(store, /supplier_api_not_connected_no_external_order_placed/, "unconnected supplier status must be explicit");
assert.doesNotMatch(store, /status:\s*placed\s*\?\s*"placed"/, "database-only records must never be marked placed");
assert.match(store, /if \(args\.approved\)\s*\{\s*throw new Error\("human_admin_approval_not_supported"\)/, "service must reject approval until admin identity is verified");
assert.match(store, /error\.code === "23505" && \/idempotency_key\/i\.test\(error\.message\)/, "concurrent retries must resolve through the unique idempotency key");
assert.match(store, /\.eq\("idempotency_key", idempotencyKey\)\s*\.maybeSingle\(\)/, "unique-key conflict must return the already-created order");


console.log("PASS: orders GET/POST require trusted automation auth; unverified approval is rejected before writes; supplier orders remain unplaced and idempotent");
