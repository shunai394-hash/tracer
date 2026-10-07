import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";

const db = createSupabaseAdminClient();
const deadlineAt = Date.now() + 25 * 60_000;

async function gateCount() {
  const { count, error } = await db
    .from("shop_listings")
    .select("id", { count: "exact", head: true })
    .eq("pipeline_reason", "sales_test_gate_passed");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function runCycle(cycle: number) {
  console.log(`=== TRACER DIRECT GATE CYCLE ${cycle} ===`);
  const before = await gateCount();
  console.log(JSON.stringify({ before }));

  if (before >= 900) return { done: true, before, after: before };

  const discovery = await discoverAndCreateCjSupply(400, { deadlineAt });
  console.log(JSON.stringify({
    discovery: {
      discovered: discovery.discovered,
      verified: discovery.verified,
      rejected: discovery.rejected,
      eligibleCount: discovery.eligibleCount,
      candidateCount: discovery.candidateCount,
      deadlineReached: discovery.deadlineReached,
    },
  }));

  const { data: supplyRows, error: supplyError } = await db
    .from("supplier_listings")
    .select("product_id")
    .in("supplier", ["cj", "cjdropshipping"])
    .eq("verification_status", "verified")
    .or("identity_status.eq.linked,identity_status.eq.supply_discovered")
    .eq("orderable", true)
    .eq("inventory_confirmed", true)
    .gt("inventory", 0)
    .not("product_id", "is", null)
    .order("last_verified_at", { ascending: false, nullsFirst: false })
    .limit(400);
  if (supplyError) throw new Error(supplyError.message);

  const productIds = Array.from(new Set((supplyRows ?? []).map(r => String(r.product_id ?? "")).filter(Boolean)));
  if (productIds.length === 0) {
    console.log(JSON.stringify({ productIds: 0, reason: "no_verified_supply" }));
    return { done: false, before, after: await gateCount() };
  }

  await buildOpportunityIntelligence({ productIds });

  const selected = await selectAndPublishSupplySalesTests(productIds, 400);
  console.log(JSON.stringify({
    considered: selected.considered,
    published: selected.published,
    rejected: selected.rejected.slice(0, 20),
  }));

  if (selected.selectedListingIds.length) {
    try {
      const base = await publishPublishedListingsToBase(400, selected.selectedListingIds);
      console.log(JSON.stringify({ basePublished: base.published, baseFailed: base.failed }));
    } catch (error) {
      console.log(JSON.stringify({ baseError: error instanceof Error ? error.message : String(error) }));
    }
  }

  const after = await gateCount();
  console.log(JSON.stringify({ after, added: after - before }));
  return { done: after >= 900, before, after };
}

for (let cycle = 1; cycle <= 6 && Date.now() < deadlineAt; cycle++) {
  const result = await runCycle(cycle);
  if (result.done) {
    console.log(JSON.stringify({ ok: true, target: 900, gatePassed: result.after }));
    process.exit(0);
  }
}

const finalCount = await gateCount();
console.log(JSON.stringify({ ok: finalCount >= 900, target: 900, gatePassed: finalCount }));
if (finalCount < 900) process.exit(2);
