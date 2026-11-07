import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getPublishableSupplierListingStatuses } from "@/lib/catalog/canonical-supplier-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_SUPPLIER_FACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function hasJapaneseText(value: unknown): value is string {
  return typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

function isFreshVerifiedAt(value: unknown, now: number): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    timestamp >= now - MAX_SUPPLIER_FACT_AGE_MS &&
    timestamp <= now + MAX_FUTURE_SKEW_MS;
}

/**
 * Read-only AI-live feed. Only exact, freshly verified supplier variants with
 * positive contribution profit and publicly available BASE pages are returned.
 * Supplier costs and internal gate diagnostics are never exposed.
 */
function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function GET(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
    : 10;

  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("shop_listings")
      .select("id,product_id,title,description,selling_price,currency,inventory,published,orderable,tracking_available,slug,base_item_id,base_publication_status,archived_at,updated_at,supplier_listing_id,supplier_product_id,supplier_variant_id,source_cost,shipping_cost,contribution_profit")
      .eq("published", true)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .gt("inventory", 0)
      .gt("selling_price", 0)
      .gt("source_cost", 0)
      .gte("shipping_cost", 0)
      .gt("contribution_profit", 0)
      .is("archived_at", null)
      .not("supplier_listing_id", "is", null)
      .not("supplier_product_id", "is", null)
      .not("supplier_variant_id", "is", null)
      .not("base_item_id", "is", null)
      .eq("base_publication_status", "published")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) throw new Error("shop_listings_read_failed");

    const rows = data ?? [];
    const identityStatuses = await getPublishableSupplierListingStatuses(rows.map((row) => ({
      listingId: String(row.id),
      supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
      productId: row.product_id == null ? null : String(row.product_id),
      supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
      supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
    })));
    const supplierIds = [...new Set(rows.map((row) => String(row.supplier_listing_id)).filter(Boolean))];
    const supplierById = new Map<string, Record<string, unknown>>();

    for (let offset = 0; offset < supplierIds.length; offset += 100) {
      const batch = supplierIds.slice(offset, offset + 100);
      const { data: suppliers, error: supplierError } = await db
        .from("supplier_listings")
        .select("id,product_id,supplier,supplier_product_id,supplier_variant_id,verification_status,shipping_status,configured,price_confirmed,inventory_confirmed,api_available,orderable,tracking_available,cost,shipping_cost,inventory,ship_to,last_verified_at")
        .in("id", batch);
      if (supplierError) throw new Error("supplier_verification_read_failed");
      for (const supplier of suppliers ?? []) supplierById.set(String(supplier.id), supplier as Record<string, unknown>);
    }

    const now = Date.now();
    const products = rows.flatMap((row) => {
      const listingId = String(row.id);
      const supplierId = String(row.supplier_listing_id ?? "");
      const supplier = supplierById.get(supplierId);
      if (!supplier || !["linked", "native_cj_verified"].includes(identityStatuses.get(listingId) ?? "")) return [];
      if (String(supplier.product_id ?? "") !== String(row.product_id ?? "") ||
          String(supplier.supplier_product_id ?? "") !== String(row.supplier_product_id ?? "") ||
          String(supplier.supplier_variant_id ?? "") !== String(row.supplier_variant_id ?? "")) return [];
      if (supplier.verification_status !== "verified" ||
          supplier.shipping_status !== "verified" ||
          supplier.configured !== true ||
          supplier.price_confirmed !== true ||
          supplier.inventory_confirmed !== true ||
          supplier.api_available !== true ||
          supplier.orderable !== true ||
          supplier.tracking_available !== true ||
          String(supplier.ship_to ?? "").trim().toUpperCase() !== "JP" ||
          Number(supplier.inventory) <= 0 ||
          Number(supplier.cost) <= 0 ||
          Number(supplier.shipping_cost) < 0 ||
          !isFreshVerifiedAt(supplier.last_verified_at, now)) return [];
      if (!hasJapaneseText(row.title) || !row.title.trim() ||
          typeof row.selling_price !== "number" || !Number.isFinite(row.selling_price) || row.selling_price <= 0 ||
          typeof row.inventory !== "number" || !Number.isFinite(row.inventory) || row.inventory <= 0 ||
          typeof row.contribution_profit !== "number" || !Number.isFinite(row.contribution_profit) || row.contribution_profit <= 0) return [];
      const productUrl = row.base_item_id && row.base_publication_status === "published"
        ? `https://tracer.base.ec/items/${encodeURIComponent(String(row.base_item_id))}`
        : null;
      if (!productUrl) return [];
      const description = hasJapaneseText(row.description) ? row.description.trim() : null;
      const verifiedAt = String(supplier.last_verified_at);
      const factsVersion = [listingId, String(row.updated_at ?? ""), verifiedAt,
        String(row.selling_price), String(row.inventory)].join(":");
      return [{
        id: listingId,
        title: String(row.title).trim(),
        description,
        sellingPrice: Number(row.selling_price),
        currency: typeof row.currency === "string" && row.currency.trim() ? row.currency : "JPY",
        inStock: true,
        productUrl,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
        factsVersion,
        factsVerifiedAt: verifiedAt,
        scriptText: description
          ? `${String(row.title).trim()}。${description.slice(0, 900)} 価格は${Number(row.selling_price).toLocaleString("ja-JP")}円です。詳しくは商品ページをご確認ください。`
          : `${String(row.title).trim()}。価格は${Number(row.selling_price).toLocaleString("ja-JP")}円です。詳しくは商品ページをご確認ください。`,
      }];
    }).slice(0, limit);

    return NextResponse.json({
      ok: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      count: products.length,
      products,
    }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "ai_live_product_read_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
