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
 * Does not write product, offer, listing, BASE, or Shopify records. The shared
 * CJ client may update API quota/rate-limit bookkeeping in Supabase.
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
  const results: Array<Record<string, unknown>> = [];

  // Sequential requests respect CJ's shared request-rate limit.
  for (const offerId of offerIds) {
    const offer = byId.get(offerId);
    if (!offer) {
      results.push({ offerId, ok: false, status: "failed", error: "cj_offer_not_found" });
      continue;
    }

    const productId = offer.supplier_product_id?.trim() ?? "";
    const variantId = offer.supplier_variant_id?.trim() ?? "";
    if (!nativeId(productId) || !nativeId(variantId)) {
      results.push({ offerId, ok: false, status: "failed", error: "invalid_stored_cj_native_ids" });
      continue;
    }

    const stored = {
      sourceStatus: offer.source_status,
      unitCost: offer.unit_cost,
      shippingCost: offer.shipping_cost,
      inventory: offer.inventory,
      shipTo: offer.ship_to,
      trackingSupported: offer.tracking_supported,
      lastCheckedAt: offer.last_checked_at,
      supplierUrl: offer.supplier_url,
    };

    try {
      const variant = await fetchCJVariantByVid(variantId);
      if (!variant) {
        results.push({
          offerId, ok: false, status: "failed", error: "cj_variant_not_found",
          identityVerified: false, stockVerified: false, freightVerified: false,
          stored: { ...stored, supplierProductId: productId, supplierVariantId: variantId },
        });
        continue;
      }

      const parentMatches = variant.productId === productId;
      const variantMatches = variant.vid === variantId;
      if (!parentMatches || !variantMatches) {
        results.push({
          offerId, ok: false, status: "mismatch", error: "stored_cj_identity_mismatch",
          identityVerified: false, stockVerified: false, freightVerified: false,
          identity: {
            storedProductId: productId, liveProductId: variant.productId,
            storedVariantId: variantId, liveVariantId: variant.vid,
            parentMatches, variantMatches,
          },
          stored,
          publicationDecision: "not_evaluated_or_changed",
        });
        continue;
      }

      let stock: unknown = null;
      let stockError: string | null = null;
      try {
        stock = await fetchCJVariantStock(variantId);
      } catch (error) {
        stockError = error instanceof Error ? error.message : String(error);
      }

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

      const stockVerified = stock !== null && stock !== undefined && stockError === null;
      const freightVerified = typeof freight === "number" && Number.isFinite(freight) && freight >= 0 && freightError === null;
      // Tracking is deliberately not inferred from a stored boolean. This route
      // cannot certify end-to-end tracking support, so it can never return a
      // fully verified/sale-ready status.
      const status = !stockVerified || !freightVerified
        ? "partial_data_unverified"
        : "partial_unverified_tracking";

      results.push({
        offerId,
        ok: false,
        status,
        identityVerified: true,
        stockVerified,
        freightVerified,
        trackingVerified: false,
        identity: {
          storedProductId: productId, liveProductId: variant.productId,
          storedVariantId: variantId, liveVariantId: variant.vid,
          parentMatches, variantMatches, sku: variant.sku, nameEn: variant.nameEn,
        },
        live: {
          verifiedWarehouseInventory: variant.inventory,
          inventoryByCountry: variant.inventoryByCountry,
          stockEndpointInventory: stock,
          stockError,
          japanFreightQuote: freight,
          freightDiagnostics,
          freightError,
          trackingCapability: "not_verified_by_this_endpoint",
        },
        stored,
        publicationDecision: "not_evaluated_or_changed",
      });
    } catch (error) {
      results.push({
        offerId,
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        identityVerified: false,
        stockVerified: false,
        freightVerified: false,
        trackingVerified: false,
        publicationDecision: "not_evaluated_or_changed",
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, result) => {
    const status = String(result.status ?? "unknown");
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    // "ok" means the full evidence set is complete; this endpoint intentionally
    // cannot achieve that while tracking capability remains unverified.
    ok: results.length > 0 && results.every((result) => result.status === "verified"),
    mode: "read_only_supplier_evidence_diagnostic",
    requested: offerIds.length,
    checked: results.filter((result) => result.identityVerified === true).length,
    counts,
    results,
    note: "This route never certifies an offer as sale-ready because tracking is not independently verified here. No product, supplier offer, listing, BASE, or Shopify records are written; CJ quota/rate-limit bookkeeping may update independently.",
  });
}
