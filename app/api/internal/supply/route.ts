import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { syncTracerCatalogFromInternalSupply } from "@/lib/suppliers/sync-tracer-catalog";
import { shouldSyncInternalSupplyCatalog } from "@/lib/suppliers/cj-identity-reverify-policy";

export const runtime = "nodejs";

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return NextResponse.json({ ok: false, error: "items required" }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  let accepted = 0;
  let rejected = 0;
  let catalogSynced = 0;
  let catalogReady = 0;
  const errors: string[] = [];

  for (const x of items) {
    const cost = finiteNumber(x.cost);
    const shipping = finiteNumber(x.shippingCost) ?? 0;
    const inventory = Math.max(0, finiteNumber(x.inventory) ?? 0);
    const salePrice = finiteNumber(x.salePrice);
    const sourceRef = typeof x.sourceRef === "string" && x.sourceRef.trim() ? x.sourceRef.trim() : null;
    const sourceName = typeof x.sourceName === "string" && x.sourceName.trim() ? x.sourceName.trim() : "internal";

    if (!x.title || cost === null || cost < 0 || !sourceRef) {
      rejected++;
      if (!sourceRef) errors.push("sourceRef required for idempotent internal supply ingestion");
      continue;
    }

    const bestsellerId =
      typeof x.bestsellerId === "string" && x.bestsellerId.trim() ? x.bestsellerId.trim() : null;

    const productPayload = {
      product_id: typeof x.productId === "string" && x.productId ? x.productId : null,
      sku: typeof x.sku === "string" ? x.sku : null,
      title: String(x.title),
      brand: x.brand ?? null,
      jan: x.jan ?? null,
      gtin: x.gtin ?? null,
      ean: x.ean ?? null,
      upc: x.upc ?? null,
      mpn: x.mpn ?? null,
      cost,
      shipping_cost: shipping,
      currency: x.currency ?? "JPY",
      inventory,
      lead_time_days: x.leadTimeDays ?? null,
      ship_to: x.shipTo ?? "JP",
      tracking_available: Boolean(x.trackingAvailable),
      order_method: x.orderMethod ?? "internal",
      api_available: Boolean(x.apiAvailable),
      active: x.active !== false,
      source_name: sourceName,
      source_ref: sourceRef,
      metadata: x.metadata ?? {},
      fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let supplyProduct: { id: string } | null = null;
    let productError: { message: string } | null = null;

    if (sourceRef) {
      const existing = await db
        .from("internal_supply_products")
        .select("id")
        .eq("source_name", sourceName)
        .eq("source_ref", sourceRef)
        .maybeSingle();
      if (existing.error) productError = { message: existing.error.message };
      else if (existing.data) {
        const updated = await db
          .from("internal_supply_products")
          .update(productPayload)
          .eq("id", existing.data.id)
          .select("id")
          .single();
        supplyProduct = updated.data ? { id: String(updated.data.id) } : null;
        if (updated.error) productError = { message: updated.error.message };
      } else {
        const inserted = await db
          .from("internal_supply_products")
          .insert(productPayload)
          .select("id")
          .single();
        supplyProduct = inserted.data ? { id: String(inserted.data.id) } : null;
        if (inserted.error) productError = { message: inserted.error.message };
      }
    } else {
      const inserted = await db
        .from("internal_supply_products")
        .insert(productPayload)
        .select("id")
        .single();
      supplyProduct = inserted.data ? { id: String(inserted.data.id) } : null;
      if (inserted.error) productError = { message: inserted.error.message };
    }

    if (productError || !supplyProduct) {
      rejected++;
      errors.push(productError?.message ?? "internal_supply_products write failed");
      continue;
    }

    accepted++;
    let itemVariantErrors = 0;
    let itemVariantsWritten = 0;
    const submittedVariants = Array.isArray(x.variants) ? x.variants : [];

    for (const v of submittedVariants) {
      const variantSku = typeof v.variantSku === "string" && v.variantSku.trim() ? v.variantSku.trim() : null;
      const variantId = typeof v.variantId === "string" && v.variantId.trim() ? v.variantId.trim() : null;
      if (!variantSku && !variantId) {
        itemVariantErrors++;
        errors.push("variant requires variantSku or variantId");
        continue;
      }

      const variantPayload = {
        supply_product_id: supplyProduct.id,
        variant_sku: variantSku,
        variant_id: variantId,
        title: v.title ?? null,
        jan: v.jan ?? null,
        gtin: v.gtin ?? null,
        ean: v.ean ?? null,
        upc: v.upc ?? null,
        cost: finiteNumber(v.cost) ?? cost,
        shipping_cost: finiteNumber(v.shippingCost) ?? shipping,
        currency: v.currency ?? x.currency ?? "JPY",
        inventory: Math.max(0, finiteNumber(v.inventory) ?? inventory),
        orderable: v.orderable !== false && (finiteNumber(v.inventory) ?? inventory) > 0,
        tracking_available: v.trackingAvailable === true || Boolean(x.trackingAvailable),
        active: v.active !== false,
        metadata: v.metadata ?? {},
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const existing = await db
        .from("internal_supply_variants")
        .select("id")
        .eq("supply_product_id", supplyProduct.id)
        .eq(variantSku ? "variant_sku" : "variant_id", variantSku ?? variantId)
        .maybeSingle();

      if (existing.error) {
        itemVariantErrors++;
        errors.push(existing.error.message);
        continue;
      }

      const result = existing.data
        ? await db.from("internal_supply_variants").update(variantPayload).eq("id", existing.data.id)
        : await db.from("internal_supply_variants").insert(variantPayload);

      if (result.error) {
        itemVariantErrors++;
        errors.push(result.error.message);
      } else {
        itemVariantsWritten++;
      }
    }

    if (shouldSyncInternalSupplyCatalog({ bestsellerId, submittedVariantCount: submittedVariants.length, variantWriteErrorCount: itemVariantErrors, successfulVariantWriteCount: itemVariantsWritten })) {
      try {
        const synced = await syncTracerCatalogFromInternalSupply({
          bestsellerId,
          salePrice,
        });
        if (synced.matched) {
          catalogSynced++;
          if (synced.reason === "ready") catalogReady++;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (bestsellerId) {
      errors.push("catalog sync withheld: variants missing or variant ingestion incomplete");
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    accepted,
    rejected,
    catalogSynced,
    catalogReady,
    errors: errors.slice(0, 20),
  });
}

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const { data, error } = await createSupabaseAdminClient()
    .from("tracer_supply_catalog")
    .select("id,tracer_sku,title,brand,category,cost,shipping_cost,handling_cost,sale_price,currency,inventory,tracking_available,orderable,status,source_type,source_ref,bestseller_id,updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data ?? [] });
}
