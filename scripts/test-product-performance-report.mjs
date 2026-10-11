import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/intelligence/product-performance/route.ts", import.meta.url), "utf8");
assert.ok(route.includes("requireAutomationAuth(request)"), "performance report must be internal-only");
assert.ok(route.includes('from("shop_funnel_events")'), "measure actual tracked funnel exposure");
assert.ok(route.includes('from("shop_order_items")'), "derive revenue from order lines");
assert.ok(route.includes('String(order.payment_status ?? "").toLowerCase() === "paid"'), "only confirmed paid orders count as sales");
assert.ok(route.includes("m.views >= 100"), "do not recommend replacement without a minimum exposure sample");
assert.ok(route.includes("readOnly: true"), "report must not mutate listings");
assert.ok(route.includes("No product is automatically removed"), "replacement recommendation must not automatically delete a product");
console.log("Product performance report: 7 assertions passed");
