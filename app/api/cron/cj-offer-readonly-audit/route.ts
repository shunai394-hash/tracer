import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { calculateCJFreight, fetchCJVariantByVid, fetchCJVariantStock } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 120;

type OfferRow = {
  id: string;
  variant_id: string;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  source_status: string | null;
  unit_cost: number | null;
  shipping_cost: number | null;
  inventory: number | null;
  ship_to: string | null;
  tracking_supported: boolean | null;
  last_checked_at: string | null;
  supplier_url: string | null;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function nativeId(value: string | null): value is string {
  return typeof value === "string" && /^\d{10,25}$/.test(value.trim());
}

/**
 * Read-only supplier evidence diagnostic.
 * Reads supplier_offers and requests live CJ variant/stock/freight data, but does
 * not update product, offer, listing, BASE, or Shopify records. The shared CJ
 * client may still maintain its own API quota/rate-limit bookkeeping.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const offerIds = [...new Set((url.searchParams.get("offerIds") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean))];

  if (offerIds.length < 1 || offerIds.length > 3 || offerIds.some((id) => !isUuid(id))) {
    return NextResponse.json({
      ok: false,
      error: "invalid_offer_ids",
      message: "Provide 1-3 comma-separated supplier_offers UUIDs in offerIds.",
      maxOfferIds: 3,
    }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const { data: offers, error } = await db
    .from("supplier_offers")
    .select("id,variant_id,supplier_product_id,supplier_variant_id,source_status,unit_cost,shipping_cost,inventory,ship_to,tracking_supported,last_checked_at,supplier_url")
    .eq("supplier_code", "cj")
    .in("id", offerIds);

  if (error) {
    return NextResponse.json({ ok: false, error: "supplier_offer_read_failed" }, { status: 500 });
  }

  const found = (offers ?? []) as OfferRow[];
  const byId = new Map(found.map((offer) => [offer.id, offer]));
  const results = [];

  // Deliberately sequential: CJ applies a strict request-rate limit.
  for (const offerId of offerIds) {
    const offer = byId.get(offerId);
    if (!offer) {
      results.push({ offerId, ok: false, error: "cj_offer_not_found" });
      continue;
    }

    const productId = offer.supplier_product_id?.trim() ?? "";
    const variantId = offer.supplier_variant_id?.trim() ?? "";
    if (!nativeId(productId) || !nativeId(variantId)) {
      results.push({ offerId, ok: false, error: "invalid_stored_cj_native_ids" });
      continue;
    }

    try {
      const variant = await fetchCJVariantByVid(variantId);
      if (!variant) {
        results.push({
          offerId,
          ok: false,
          error: "cj_variant_not_found",
          stored: {
            supplierProductId: productId,
            supplierVariantId: variantId,
            sourceStatus: offer.source_status,
            inventory: offer.inventory,
            shippingCost: offer.shipping_cost,
            shipTo: offer.ship_to,
            trackingSupported: offer.tracking_supported,
            lastCheckedAt: offer.last_checked_at,
          },
        });
        continue;
      }

      const parentMatches = variant.productId === productId;
      const stock = await fetchCJVariantStock(variantId);
      const freightDiagnostics: string[] = [];
      let freight: number | null = null;
      let freightError: string | null = null;
      try {
        freight = await calculateCJFreight(variantId, {
          productId,
          startCountryCode: "CN",
          endCountryCode: "JP",
          quantity: 1,
          diagnostics: freightDiagnostics,
        });
      } catch (error) {
        freightError = error instanceof Error ? error.message : String(error);
      }

      results.push({
        offerId,
        ok: parentMatches,
        identity: {
          storedProductId: productId,
          liveProductId: variant.productId,
          storedVariantId: variantId,
          liveVariantId: variant.vid,
          parentMatches,
          variantMatches: variant.vid === variantId,
          sku: variant.sku,
          nameEn: variant.nameEn,
        },
        live: {
          verifiedWarehouseInventory: variant.inventory,
          inventoryByCountry: variant.inventoryByCountry,
          stockEndpointInventory: stock,
          japanFreightQuote: freight,
          freightDiagnostics,
          freightError,
          // This endpoint does not establish parcel tracking capability.
          trackingCapability: "not_verified_by_this_endpoint",
        },
        stored: {
          sourceStatus: offer.source_status,
          unitCost: offer.unit_cost,
          shippingCost: offer.shipping_cost,
          inventory: offer.inventory,
          shipTo: offer.ship_to,
          trackingSupported: offer.tracking_supported,
          lastCheckedAt: offer.last_checked_at,
          supplierUrl: offer.supplier_url,
        },
        publicationDecision: "not_evaluated_or_changed",
      });
    } catch (error) {
      results.push({
        offerId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        publicationDecision: "not_evaluated_or_changed",
      });
    }
  }

  return NextResponse.json({
    ok: results.every((item) => item.ok),
    mode: "read_only_supplier_evidence_diagnostic",
    requested: offerIds.length,
    checked: results.filter((item) => item.ok).length,
    results,
    note: "No product, supplier offer, listing, BASE, or Shopify records are written by this route. CJ client quota/rate-limit bookkeeping may update independently.",
  });
}
