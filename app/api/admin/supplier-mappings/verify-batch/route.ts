import "server-only";

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { initializeProcurement } from "@/lib/procurement/init";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 10;

async function runVerification(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  initializeProcurement();
  const db = createSupabaseAdminClient();
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") ?? DEFAULT_BATCH_SIZE);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;

  const { data: mappings, error } = await db
    .from("supplier_product_mappings")
    .select("id,supplier_listing_id,supplier_account_id")
    .eq("active", true)
    .eq("verification_status", "unverified")
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const mapping of mappings ?? []) {
    const testedAt = new Date().toISOString();
    const [{ data: listing }, { data: account }] = await Promise.all([
      db.from("supplier_listings").select("supplier,supplier_product_id,supplier_variant_id").eq("id", mapping.supplier_listing_id).maybeSingle(),
      db.from("supplier_accounts").select("code").eq("id", mapping.supplier_account_id).maybeSingle(),
    ]);

    if (!listing || !account || !listing.supplier_product_id || !listing.supplier_variant_id) {
      const reason = "supplier_mapping_target_missing";
      await db.from("supplier_product_mappings").update({ automation_status: "failed", verification_status: "failed", verification_error: reason, last_tested_at: testedAt, updated_at: testedAt }).eq("id", mapping.id);
      results.push({ mappingId: mapping.id, ok: false, error: reason });
      continue;
    }

    const adapter = getSupplierAdapter(account.code);
    if (!adapter) {
      const reason = "supplier_adapter_not_registered";
      await db.from("supplier_product_mappings").update({ automation_status: "failed", verification_status: "failed", verification_error: reason, last_tested_at: testedAt, updated_at: testedAt }).eq("id", mapping.id);
      results.push({ mappingId: mapping.id, ok: false, error: reason });
      continue;
    }

    await db.from("supplier_product_mappings").update({ automation_status: "testing", verification_error: null, last_tested_at: testedAt, updated_at: testedAt }).eq("id", mapping.id);

    try {
      const [inventory, shipping] = await Promise.all([
        adapter.getInventory(listing.supplier_product_id, listing.supplier_variant_id),
        adapter.getShipping(listing.supplier_product_id, listing.supplier_variant_id, { destinationCountryCode: "JP", quantity: 1 }),
      ]);
      const inventoryOk = inventory?.available === true;
      const shippingOk = shipping?.available === true;
      const verified = inventoryOk && shippingOk;
      const verificationError = verified ? null : `live_check_failed:inventory=${inventory?.quantity ?? "unknown"} shipping=${shipping?.amount ?? "unknown"}`;
      await db.from("supplier_product_mappings").update({
        automation_status: verified ? "testing" : "failed",
        verification_status: verified ? "verified" : "failed",
        verification_error: verificationError,
        last_tested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", mapping.id);
      results.push({ mappingId: mapping.id, supplier: account.code, ok: verified, inventory: inventory?.quantity ?? null, shipping: shipping?.amount ?? null });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await db.from("supplier_product_mappings").update({ automation_status: "failed", verification_status: "failed", verification_error: message, last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", mapping.id);
      results.push({ mappingId: mapping.id, ok: false, error: message });
    }
  }

  return NextResponse.json({
    ok: true,
    requested: limit,
    processed: results.length,
    succeeded: results.filter((result) => result.ok === true).length,
    failed: results.filter((result) => result.ok === false).length,
    note: "Verification checks live supplier inventory and Japan shipping. It does not create supplier orders or enable supplier payment automation.",
  });
}

export async function POST(request: Request) {
  return runVerification(request);
}

export async function GET(request: Request) {
  return runVerification(request);
}
