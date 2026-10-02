import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

type MappingBody = {
  shopListingId?: string;
  supplierListingId?: string;
  supplierAccountId?: string;
  priority?: number;
  active?: boolean;
  autoOrderEnabled?: boolean;
  autoPaymentEnabled?: boolean;
  autoTrackingEnabled?: boolean;
  automationStatus?: "unverified" | "testing" | "eligible" | "blocked" | "failed";
  verificationStatus?: "unverified" | "verified" | "failed";
  verificationError?: string | null;
};

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const url = new URL(request.url);
  const shopListingId = url.searchParams.get("shopListingId");
  const supplierCode = url.searchParams.get("supplier");

  let query = db
    .from("supplier_product_mapping_status")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (shopListingId) query = query.eq("shop_listing_id", shopListingId);
  if (supplierCode) query = query.eq("supplier_code", supplierCode);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, mappings: data ?? [] });
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as MappingBody | null;
  if (!body?.shopListingId || !body.supplierListingId || !body.supplierAccountId) {
    return NextResponse.json(
      { ok: false, error: "shopListingId_supplierListingId_supplierAccountId_required" },
      { status: 422 },
    );
  }

  const db = createSupabaseAdminClient();

  const [{ data: shop, error: shopError }, { data: supplierListing, error: supplierError }, { data: account, error: accountError }] =
    await Promise.all([
      db.from("shop_listings").select("id,supplier_name").eq("id", body.shopListingId).maybeSingle(),
      db.from("supplier_listings").select("id,supplier").eq("id", body.supplierListingId).maybeSingle(),
      db.from("supplier_accounts").select("id,code,active").eq("id", body.supplierAccountId).maybeSingle(),
    ]);

  if (shopError || supplierError || accountError) {
    return NextResponse.json(
      { ok: false, error: shopError?.message ?? supplierError?.message ?? accountError?.message },
      { status: 500 },
    );
  }
  if (!shop) return NextResponse.json({ ok: false, error: "shop_listing_not_found" }, { status: 404 });
  if (!supplierListing) return NextResponse.json({ ok: false, error: "supplier_listing_not_found" }, { status: 404 });
  if (!account) return NextResponse.json({ ok: false, error: "supplier_account_not_found" }, { status: 404 });
  if (account.active !== true) return NextResponse.json({ ok: false, error: "supplier_account_inactive" }, { status: 422 });
  if (shop.supplier_name && shop.supplier_name !== supplierListing.supplier) {
    return NextResponse.json({ ok: false, error: "supplier_mismatch" }, { status: 422 });
  }
  if (account.code !== supplierListing.supplier) {
    return NextResponse.json({ ok: false, error: "supplier_account_mismatch" }, { status: 422 });
  }

  const { data, error } = await db
    .from("supplier_product_mappings")
    .upsert(
      {
        shop_listing_id: body.shopListingId,
        supplier_listing_id: body.supplierListingId,
        supplier_account_id: body.supplierAccountId,
        priority: body.priority ?? 1,
        active: body.active ?? true,
        auto_order_enabled: body.autoOrderEnabled ?? false,
        auto_payment_enabled: body.autoPaymentEnabled ?? false,
        auto_tracking_enabled: body.autoTrackingEnabled ?? false,
        automation_status: body.automationStatus ?? "unverified",
        verification_status: body.verificationStatus ?? "unverified",
        verification_error: body.verificationError ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shop_listing_id,supplier_listing_id" },
    )
    .select("id")
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, mappingId: data.id });
}

export async function PATCH(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const body = (await request.json().catch(() => null)) as MappingBody | null;
  if (!id || !body) {
    return NextResponse.json({ ok: false, error: "id_and_body_required" }, { status: 422 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.active !== undefined) patch.active = body.active;
  if (body.autoOrderEnabled !== undefined) patch.auto_order_enabled = body.autoOrderEnabled;
  if (body.autoPaymentEnabled !== undefined) patch.auto_payment_enabled = body.autoPaymentEnabled;
  if (body.autoTrackingEnabled !== undefined) patch.auto_tracking_enabled = body.autoTrackingEnabled;
  if (body.automationStatus !== undefined) patch.automation_status = body.automationStatus;
  if (body.verificationStatus !== undefined) patch.verification_status = body.verificationStatus;
  if (body.verificationError !== undefined) patch.verification_error = body.verificationError;
  if (body.verificationStatus === "verified") patch.last_tested_at = new Date().toISOString();

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("supplier_product_mappings")
    .update(patch)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "mapping_not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, mappingId: data.id });
}
