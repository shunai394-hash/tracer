import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
type ShopifyNode = {
  id: string;
  status?: string | null;
  variants?: { nodes: Array<{ id: string; sku: string | null; price: string | null; inventoryQuantity?: number | null }> };
};

function str(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}
function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function visible(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    if (["1", "true", "visible", "public"].includes(value.toLowerCase())) return true;
    if (["0", "false", "hidden", "private"].includes(value.toLowerCase())) return false;
  }
  return null;
}
async function readListings() {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("channel_listings")
    .select("channel,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status,last_synced_at")
    .in("channel", ["BASE", "base", "Shopify", "shopify", "NEWFIND", "newfind"])
    .order("variant_id", { ascending: true })
    .limit(500);
  if (error) throw new Error("channel_listings_read_failed");
  return (data ?? []) as unknown as Row[];
}

/**
 * Explicit, bounded live read probe. Call with ?live=1 to avoid making external
 * API calls on routine report requests. Reads only existing external IDs; never
 * searches by title and never writes to a channel or database.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  if (url.searchParams.get("live") !== "1") {
    return NextResponse.json(
      { ok: false, readOnly: true, error: "explicit_live_flag_required", usage: "?live=1" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const rows = await readListings();
    const baseRows = rows.filter((row) => ["base"].includes(String(row.channel ?? "").toLowerCase()) && /^\d+$/.test(str(row.external_product_id) ?? ""));
    const shopifyRows = rows.filter((row) => String(row.channel ?? "").toLowerCase() === "shopify" && Boolean(str(row.external_product_id)));
    const newfindRows = rows.filter((row) => String(row.channel ?? "").toLowerCase() === "newfind");
    const baseSample = baseRows.slice(0, 20);
    const shopifySample = shopifyRows.slice(0, 20);
    const base: Array<Record<string, unknown>> = [];
    const shopify: Array<Record<string, unknown>> = [];
    const errors: Array<{ channel: string; reason: string }> = [];

    if (!isBaseConfigured()) {
      errors.push({ channel: "BASE", reason: "base_oauth_not_configured" });
    } else {
      for (const listing of baseSample) {
        const id = str(listing.external_product_id)!;
        try {
          const item = await getBaseItemDetail(id);
          base.push({
            requestedExternalId: id,
            returnedExternalId: str(item.item_id),
            sku: str(item.identifier),
            price: num(item.price),
            stock: num(item.stock),
            published: visible(item.visible),
            observedAt: new Date().toISOString(),
            identityVerified: str(item.item_id) === id,
          });
        } catch {
          errors.push({ channel: "BASE", reason: "item_read_failed:" + id });
        }
      }
    }

    if (!isShopifyConfigured()) {
      errors.push({ channel: "Shopify", reason: "shopify_admin_api_not_configured" });
    } else {
      const ids = [...new Set(shopifySample.map((row) => str(row.external_product_id)).filter((id): id is string => Boolean(id)))];
      const gids = ids.map((id) => id.startsWith("gid://shopify/") ? id : /^\d+$/.test(id) ? "gid://shopify/Product/" + id : id);
      if (gids.length) {
        try {
          const result = await shopifyGraphQL<{ nodes: Array<ShopifyNode | null> }>(
            "query OpsBotReadOnlyChannelCheck($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status variants(first: 100) { nodes { id sku price inventoryQuantity } } } } }",
            { ids: gids },
          );
          for (const node of result.nodes ?? []) {
            if (!node) continue;
            shopify.push({
              externalProductId: node.id,
              status: node.status ?? null,
              variants: (node.variants?.nodes ?? []).map((variant) => ({
                externalVariantId: variant.id,
                sku: variant.sku,
                price: num(variant.price),
                stock: num(variant.inventoryQuantity),
              })),
              observedAt: new Date().toISOString(),
            });
          }
        } catch {
          errors.push({ channel: "Shopify", reason: "product_read_failed" });
        }
      }
    }

    return NextResponse.json({
      ok: errors.length === 0,
      readOnly: true,
      mode: "bounded_live_read",
      limits: { maxBaseItems: 20, maxShopifyProducts: 20, databaseListingRows: 500 },
      samples: {
        BASE: { requested: baseSample.length, verified: base.filter((item) => item.identityVerified === true).length, items: base },
        Shopify: { requested: shopifySample.length, returned: shopify.length, products: shopify },
        NEWFIND: { storedRows: newfindRows.length, liveVerification: "not_implemented" },
      },
      errors,
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json(
      { ok: false, readOnly: true, error: "live_channel_check_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
