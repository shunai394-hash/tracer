import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { syncTracerCatalogFromInternalSupply } from "@/lib/suppliers/sync-tracer-catalog";
import { shouldSyncInternalSupplyCatalog } from "@/lib/suppliers/cj-identity-reverify-policy";

export const runtime = "nodejs";

async function quarantineCatalogForBestseller(
  db: ReturnType<typeof createSupabaseAdminClient>,
  bestsellerId: string,
): Promise<void> {
  const { data, error } = await db
    .from("tracer_supply_catalog")
    .update({ status: "draft", orderable: false, inventory: 0, updated_at: new Date().toISOString() })
    .eq("bestseller_id", bestsellerId)
    .select("id");
  if (error) throw new Error(error.message);
  const catalogIds = (data ?? []).map((row: { id: string }) => row.id);
  if (catalogIds.length === 0) return;
  const { error: variantError } = await db
    .from("tracer_supply_variants")
    .update({ orderable: false, inventory: 0, updated_at: new Date().toISOString() })
    .in("catalog_id", catalogIds);
  if (variantError) throw new Error(variantError.message);
}

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

    const submittedVariants = Array.isArray(x.variants) ? x.variants : [];
    const intendedProductActive = x.active !== false;
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
      // Keep the product unselectable until this request writes every submitted variant.
      active: false,
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
    const writtenVariantIds: string[] = [];

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
        ? await db.from("internal_supply_variants").update(variantPayload).eq("id", existing.data.id).select("id").single()
        : await db.from("internal_supply_variants").insert(variantPayload).select("id").single();

      if (result.error || !result.data) {
        itemVariantErrors++;
        errors.push(result.error?.message ?? "internal_supply_variants write returned no row");
      } else {
        itemVariantsWritten++;
        writtenVariantIds.push(String(result.data.id));
      }
    }

    const completeVariantWrite = submittedVariants.length > 0
      && itemVariantErrors === 0
      && itemVariantsWritten === submittedVariants.length
      && writtenVariantIds.length === submittedVariants.length;

    let productActivated = false;
    if (completeVariantWrite) {
      const activated = await db
        .from("internal_supply_products")
        .update({ active: intendedProductActive, updated_at: new Date().toISOString() })
        .eq("id", supplyProduct.id)
        .select("id")
        .single();
      if (activated.error || !activated.data) {
        errors.push(activated.error?.message ?? "internal supply product activation returned no row");
      } else {
        productActivated = intendedProductActive;
      }
    }

    if (shouldSyncInternalSupplyCatalog({
      bestsellerId,
      submittedVariantCount: submittedVariants.length,
      variantWriteErrorCount: itemVariantErrors,
      successfulVariantWriteCount: itemVariantsWritten,
    }) && productActivated) {
      try {
        const synced = await syncTracerCatalogFromInternalSupply({
          bestsellerId,
          salePrice,
          variantIds: writtenVariantIds,
        });
        if (synced.matched) {
          catalogSynced++;
          if (synced.reason === "ready") catalogReady++;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else if (bestsellerId && !productActivated) {
      errors.push("catalog sync withheld: variants missing, incomplete, or product activation failed");
      try {
        await quarantineCatalogForBestseller(db, bestsellerId);
      } catch (error) {
        errors.push(`catalog quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
      }
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
