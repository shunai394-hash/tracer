import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const required = ["title", "source_name"];
  for (const key of required) {
    if (typeof body[key] !== "string" || !body[key].trim()) {
      return NextResponse.json({ ok: false, error: `${key}_required` }, { status: 400 });
    }
  }

  const supabase = createSupabaseAdminClient();
  const { data: product, error } = await supabase
    .from("internal_supply_products")
    .insert({
      product_id: body.product_id ?? null,
      sku: body.sku ?? null,
      title: body.title,
      brand: body.brand ?? null,
      jan: body.jan ?? null,
      gtin: body.gtin ?? null,
      ean: body.ean ?? null,
      upc: body.upc ?? null,
      mpn: body.mpn ?? null,
      cost: body.cost ?? null,
      shipping_cost: body.shipping_cost ?? null,
      currency: body.currency ?? "JPY",
      inventory: body.inventory ?? 0,
      lead_time_days: body.lead_time_days ?? null,
      ship_to: body.ship_to ?? "JP",
      tracking_available: body.tracking_available === true,
      order_method: body.order_method ?? "manual",
      api_available: body.api_available === true,
      source_name: body.source_name,
      source_ref: body.source_ref ?? null,
      metadata: body.metadata ?? {},
      active: body.active !== false,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  const variants = Array.isArray(body.variants) ? body.variants : [];
  if (variants.length > 0) {
    const rows = variants.map((variant: Record<string, unknown>) => ({
      supply_product_id: product.id,
      variant_sku: variant.variant_sku ?? null,
      variant_id: variant.variant_id ?? null,
      title: variant.title ?? null,
      jan: variant.jan ?? null,
      gtin: variant.gtin ?? null,
      ean: variant.ean ?? null,
      upc: variant.upc ?? null,
      cost: variant.cost ?? body.cost ?? null,
      shipping_cost: variant.shipping_cost ?? body.shipping_cost ?? null,
      currency: variant.currency ?? body.currency ?? "JPY",
      inventory: variant.inventory ?? 0,
      orderable: variant.orderable === true,
      tracking_available: variant.tracking_available === true || body.tracking_available === true,
      metadata: variant.metadata ?? {},
    }));

    const { error: variantError } = await supabase
      .from("internal_supply_variants")
      .insert(rows);

    if (variantError) {
      await supabase.from("internal_supply_products").delete().eq("id", product.id);
      return NextResponse.json({ ok: false, error: variantError.message }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true, supplyProductId: product.id, variantCount: variants.length });
}
