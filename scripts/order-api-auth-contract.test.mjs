import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8");
const component = await readFile(new URL("../components/order-actions.tsx", import.meta.url), "utf8");

test("purchase-order API verifies a real Supabase user before reading or writing order data", () => {
  assert.match(route, /authClient\.auth\.getUser\(token\)/);
  assert.match(route, /TRACER_ADMIN_EMAILS/);
  assert.match(route, /status:\s*401/);
  assert.match(route, /status:\s*403/);
  assert.match(route, /const auth = await requireVerifiedAdmin\(request\);\s*if \(!auth\.ok\) return auth\.response;\s*try \{\s*const \[recommendations, orders\]/);
  assert.match(route, /const auth = await requireVerifiedAdmin\(request\);\s*if \(!auth\.ok\) return auth\.response;\s*\n\s*let body:/);
});

test("approval identity comes from the verified user, never a client-supplied label", () => {
  assert.match(route, /approvedBy: body\.approved === true \? auth\.admin\.email : null/);
  assert.doesNotMatch(route, /approvedBy:\s*body\.approved === true \? ["']user["']/);
  assert.match(component, /supabase\.auth\.getSession\(\)/);
  assert.match(component, /Authorization:\s*\`Bearer \\$\{session\.access_token\}\`/);
});
