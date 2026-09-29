import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const title = clean(body.title);
  const sourceName = clean(body.source_name);
  const sku = clean(body.sku);
  const sourceRef = clean(body.source_ref);
  if (!title || !sourceName) {
    return NextResponse.json({ ok: false, error: "title_and_source_name_required" }, { status: 400 });
  }

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const variants = rawVariants.map((item) => (
    item && typeof item === "object" ? item as Record<string, unknown> : {}
  ));

  // A sellable internal SKU must have a stable variant identity. For a
  // single-SKU product, the product itself becomes the source for the
  // generated variant after insertion.
  if (variants.length === 0 && !sku && !sourceRef) {
    return NextResponse.json(
      { ok: false, error: "sku_or_source_ref_required_for_single_sku" },
      { status: 400 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const productPayload = {
    product_id: clean(body.product_id),
    sku,
    title,
    brand: clean(body.brand),
    jan: clean(body.jan),
    gtin: clean(body.gtin),
    ean: clean(body.ean),
    upc: clean(body.upc),
    mpn: clean(body.mpn),
    cost: body.cost == null ? null : finiteNumber(body.cost),
    shipping_cost: body.shipping_cost == null ? null : finiteNumber(body.shipping_cost),
    currency: clean(body.currency) ?? "JPY",
    inventory: finiteNumber(body.inventory),
    lead_time_days: body.lead_time_days == null ? null : finiteNumber(body.lead_time_days),
    ship_to: clean(body.ship_to) ?? "JP",
    tracking_available: body.tracking_available === true,
    order_method: clean(body.order_method) ?? "manual",
    api_available: body.api_available === true,
    source_name: sourceName,
    source_ref: sourceRef,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    active: body.active !== false,
    fetched_at: new Date().toISOString(),
  };

  // Stable source_ref/sku makes ingestion idempotent. Never create duplicate
  // supply products when the same owned catalog feed is replayed.
  let product: { id: string } | null = null;
  let productError: { message: string } | null = null;

  if (sourceRef) {
    const existing = await supabase
      .from("internal_supply_products")
      .select("id")
      .eq("source_name", sourceName)
      .eq("source_ref", sourceRef)
      .maybeSingle();
    if (existing.error) productError = { message: existing.error.message };
    else if (existing.data?.id) product = { id: String(existing.data.id) };
  } else if (sku) {
    const existing = await supabase
      .from("internal_supply_products")
      .select("id")
      .eq("source_name", sourceName)
      .eq("sku", sku)
      .maybeSingle();
    if (existing.error) productError = { message: existing.error.message };
    else if (existing.data?.id) product = { id: String(existing.data.id) };
  }

  if (productError) {
    return NextResponse.json({ ok: false, error: productError.message }, { status: 400 });
  }

  if (product) {
    const updated = await supabase
      .from("internal_supply_products")
      .update(productPayload)
      .eq("id", product.id)
      .select("id")
      .single();
    if (updated.error) {
      return NextResponse.json({ ok: false, error: updated.error.message }, { status: 400 });
    }
    product = { id: String(updated.data.id) };
  } else {
    const inserted = await supabase
      .from("internal_supply_products")
      .insert(productPayload)
      .select("id")
      .single();
    if (inserted.error) {
      return NextResponse.json({ ok: false, error: inserted.error.message }, { status: 400 });
    }
    product = { id: String(inserted.data.id) };
  }

  // Replace the owned SKU's variants atomically enough for this API boundary:
  // deactivate existing variants first, then upsert the current feed snapshot.
  await supabase
    .from("internal_supply_variants")
    .update({ active: false })
    .eq("supply_product_id", product.id);

  const effectiveVariants = variants.length > 0
    ? variants
    : [{
        variant_sku: sku ?? sourceRef,
        variant_id: sku ?? sourceRef,
        title,
        jan: body.jan,
        gtin: body.gtin,
        ean: body.ean,
        upc: body.upc,
        cost: body.cost,
        shipping_cost: body.shipping_cost,
        currency: body.currency,
        inventory: body.inventory,
        orderable: body.orderable === true || finiteNumber(body.inventory) > 0,
        tracking_available: body.tracking_available === true,
        metadata: { generated_from_single_sku: true },
      }];

  const rows = effectiveVariants.map((variant) => ({
    supply_product_id: product!.id,
    variant_sku: clean(variant.variant_sku),
    variant_id: clean(variant.variant_id) ?? clean(variant.variant_sku),
    title: clean(variant.title) ?? title,
    jan: clean(variant.jan) ?? clean(body.jan),
    gtin: clean(variant.gtin) ?? clean(body.gtin),
    ean: clean(variant.ean) ?? clean(body.ean),
    upc: clean(variant.upc) ?? clean(body.upc),
    cost: variant.cost == null ? productPayload.cost : finiteNumber(variant.cost),
    shipping_cost: variant.shipping_cost == null ? productPayload.shipping_cost : finiteNumber(variant.shipping_cost),
    currency: clean(variant.currency) ?? productPayload.currency,
    inventory: finiteNumber(variant.inventory, productPayload.inventory),
    orderable: variant.orderable === true || finiteNumber(variant.inventory, productPayload.inventory) > 0,
    tracking_available: variant.tracking_available === true || productPayload.tracking_available,
    active: variant.active !== false,
    metadata: variant.metadata && typeof variant.metadata === "object" ? variant.metadata : {},
    fetched_at: new Date().toISOString(),
  }));

  for (const row of rows) {
    const existing = await supabase
      .from("internal_supply_variants")
      .select("id")
      .eq("supply_product_id", row.supply_product_id)
      .eq("variant_id", row.variant_id)
      .maybeSingle();
    if (existing.error) {
      return NextResponse.json({ ok: false, error: existing.error.message }, { status: 400 });
    }

    const result = existing.data?.id
      ? await supabase
          .from("internal_supply_variants")
          .update(row)
          .eq("id", existing.data.id)
      : await supabase
          .from("internal_supply_variants")
          .insert(row);

    if (result.error) {
      return NextResponse.json({ ok: false, error: result.error.message }, { status: 400 });
    }
  }

  return NextResponse.json({
    ok: true,
    supplyProductId: product.id,
    variantCount: rows.length,
    idempotentKey: sourceRef ? `${sourceName}:${sourceRef}` : `${sourceName}:${sku}`,
  });
}
