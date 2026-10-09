import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { calculateCJFreight, fetchCJProductVariants, fetchCJVariantStock } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Repairs only missing supplier economics from live CJ variant APIs.
 * This route never publishes products, changes identity links, or creates orders.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const db = createSupabaseAdminClient();
  const result = { candidates: 0, updated: 0, noVariant: 0, stillMissing: 0, errors: 0 };

  const { data: rows, error } = await db
    .from("supplier_listings")
    .select("id,supplier_product_id,supplier_variant_id,cost,shipping_cost,inventory,currency,metadata")
    .eq("supplier", "cj")
    .not("supplier_variant_id", "is", null)
    .or("cost.is.null,shipping_cost.is.null,inventory.is.null")
    .order("updated_at", { ascending: true })
    .limit(25);

  if (error) {
    return NextResponse.json({ ok: false, phase: "cj_missing_economics_repair", error: error.message }, { status: 500 });
  }

  result.candidates = rows?.length ?? 0;
  for (const row of rows ?? []) {
    try {
      const productId = String(row.supplier_product_id ?? "");
      const variantId = String(row.supplier_variant_id ?? "");
      if (!productId || !variantId) {
        result.noVariant += 1;
        continue;
      }

      const variants = await fetchCJProductVariants(productId, { countryCode: "JP" });
      const variant = variants.find((item) => item.vid === variantId);
      if (!variant?.vid) {
        result.noVariant += 1;
        continue;
      }

      const patch: Record<string, unknown> = {};
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const evidence: Record<string, unknown> = {
        ...metadata,
        economics_repaired_at: new Date().toISOString(),
        economics_repair_source: "cj_live_variant_api",
      };

      if (row.cost === null || row.cost === undefined) {
        const liveCost = Number(variant.sellPrice);
        if (Number.isFinite(liveCost) && liveCost > 0) {
          patch.cost = liveCost;
          patch.price_confirmed = true;
          if (!row.currency) patch.currency = "USD";
          evidence.live_cost_confirmed = true;
        }
      }

      if (row.shipping_cost === null || row.shipping_cost === undefined) {
        const liveShipping = await calculateCJFreight(variant.vid, { endCountryCode: "JP", quantity: 1 });
        if (liveShipping !== null && Number.isFinite(liveShipping) && liveShipping >= 0) {
          patch.shipping_cost = liveShipping;
          evidence.live_shipping_confirmed = true;
        }
      }

      if (row.inventory === null || row.inventory === undefined) {
        const liveInventory = await fetchCJVariantStock(variant.vid);
        if (liveInventory !== null && Number.isFinite(liveInventory) && liveInventory >= 0) {
          patch.inventory = liveInventory;
          patch.inventory_confirmed = true;
          patch.inventory_checked_at = new Date().toISOString();
          evidence.live_inventory_confirmed = true;
        }
      }

      if (Object.keys(patch).length === 0) {
        result.stillMissing += 1;
        continue;
      }

      patch.metadata = evidence;
      const { error: updateError } = await db
        .from("supplier_listings")
        .update(patch)
        .eq("id", row.id)
        .eq("supplier", "cj");
      if (updateError) throw new Error(updateError.message);
      result.updated += 1;
    } catch (error) {
      result.errors += 1;
      console.warn("[cj-missing-economics-repair] candidate failed", {
        supplierListingId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finishedAt = new Date().toISOString();
  await db.from("cron_runs").insert({
    job_name: "cj-missing-economics-repair",
    status: result.errors === 0 ? "succeeded" : "partial",
    started_at: startedAt,
    finished_at: finishedAt,
    processed: result.updated,
    failed: result.errors,
    metadata: { ...result, publicationTriggered: false, ordersTriggered: false },
  });

  return NextResponse.json({
    ok: result.errors === 0,
    phase: "cj_missing_economics_repair",
    elapsedMs: Date.now() - new Date(startedAt).getTime(),
    ...result,
    publicationTriggered: false,
    ordersTriggered: false,
    next: "cj_identity_reverify",
  }, { status: result.errors === 0 ? 200 : 207 });
}
