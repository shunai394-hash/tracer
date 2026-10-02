import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { initializeProcurement } from "@/lib/procurement/init";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 422 });

  initializeProcurement();
  const db = createSupabaseAdminClient();
  const { data: mapping, error } = await db
    .from("supplier_product_mappings")
    .select("id,supplier_listing_id,supplier_account_id")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!mapping) return NextResponse.json({ ok: false, error: "mapping_not_found" }, { status: 404 });

  const [{ data: listing, error: listingError }, { data: account, error: accountError }] = await Promise.all([
    db.from("supplier_listings").select("supplier,supplier_product_id,supplier_variant_id").eq("id", mapping.supplier_listing_id).maybeSingle(),
    db.from("supplier_accounts").select("code").eq("id", mapping.supplier_account_id).maybeSingle(),
  ]);
  if (listingError || accountError) {
    return NextResponse.json({ ok: false, error: listingError?.message ?? accountError?.message }, { status: 500 });
  }
  if (!listing || !account) return NextResponse.json({ ok: false, error: "supplier_mapping_target_missing" }, { status: 404 });

  const adapter = getSupplierAdapter(account.code);
  if (!adapter) {
    await db.from("supplier_product_mappings").update({
      automation_status: "failed",
      verification_status: "failed",
      verification_error: "supplier_adapter_not_registered",
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    return NextResponse.json({ ok: false, error: "supplier_adapter_not_registered" }, { status: 422 });
  }

  try {
    const [inventory, shipping] = await Promise.all([
      listing.supplier_product_id && listing.supplier_variant_id
        ? adapter.getInventory(listing.supplier_product_id, listing.supplier_variant_id)
        : Promise.resolve(null),
      listing.supplier_product_id && listing.supplier_variant_id
        ? adapter.getShipping(listing.supplier_product_id, listing.supplier_variant_id, {
            destinationCountryCode: "JP",
            quantity: 1,
          })
        : Promise.resolve(null),
    ]);

    const inventoryOk = inventory?.available === true;
    const shippingOk = shipping?.available === true;
    const verificationOk = inventoryOk && shippingOk;

    const { error: updateError } = await db.from("supplier_product_mappings").update({
      automation_status: verificationOk ? "testing" : "failed",
      verification_status: verificationOk ? "verified" : "failed",
      verification_error: verificationOk ? null : `live_check_failed:inventory=${inventory?.quantity ?? "unknown"} shipping=${shipping?.amount ?? "unknown"}`,
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (updateError) throw new Error(updateError.message);

    return NextResponse.json({
      ok: verificationOk,
      mappingId: id,
      inventory,
      shipping,
      note: "Catalog/inventory/shipping verification does not prove supplier payment automation. Payment remains gated until the supplier account is explicitly marked automatable.",
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await db.from("supplier_product_mappings").update({
      automation_status: "failed",
      verification_status: "failed",
      verification_error: message,
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
