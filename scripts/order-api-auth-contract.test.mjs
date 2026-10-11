import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8");
const auth = await readFile(new URL("../lib/security/verify-admin-request.ts", import.meta.url), "utf8");
const component = await readFile(new URL("../components/order-actions.tsx", import.meta.url), "utf8");

test("purchase-order API verifies admin identity before reading or writing order data", () => {
  assert.match(route, /verifyAdminRequest\(request,/);
  assert.match(auth, /auth\.getUser\(token\)/);
  assert.match(auth, /allowedEmails/);
  assert.match(auth, /status: 401/);
  assert.match(auth, /status: 403/);
  assert.match(route, /const auth = await requireVerifiedAdmin\(request\);\s*if \(!auth\.ok\) return auth\.response;\s*try \{\s*const \[recommendations, orders\]/);
  assert.match(route, /const auth = await requireVerifiedAdmin\(request\);\s*if \(!auth\.ok\) return auth\.response;\s*\n\s*let body:/);
});

test("approval identity comes from the verified user, never a client-supplied label", () => {
  assert.match(route, /approvedBy: body\.approved === true \? auth\.admin\.email : null/);
  assert.doesNotMatch(route, /approvedBy:\s*body\.approved === true \? ["']user["']/);
  assert.match(component, /supabase\.auth\.getSession\(\)/);
  assert.match(component, /Authorization:/);
  assert.match(component, /session\.access_token/);
});
