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

console.log("PASS: orders GET/POST require trusted automation auth; unverified approval is rejected before writes");
