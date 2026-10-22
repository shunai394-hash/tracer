import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Row = Record<string, unknown>;

function duplicateGroups(rows: Row[], keyOf: (row: Row) => string, fields: string[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      count: group.length,
      records: group.slice(0, 10).map((row) =>
        Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
      ),
      omittedRecords: Math.max(0, group.length - 10),
    }))
    .sort((a, b) => b.count - a.count);
}

async function readAll(table: string, columns: string): Promise<Row[]> {
  const db = createSupabaseAdminClient();
  const pageSize = 1000;
  const maxRows = 20000;
  const rows: Row[] = [];

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await db.from(table).select(columns)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(table + "_read_failed:" + error.message);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < pageSize) {
      return rows;
    }
  }

  throw new Error(table + "_audit_limit_exceeded:more_than_" + maxRows + "_rows");
}

/**
 * Read-only duplicate audit. It deliberately performs no upserts, publishing,
 * repairs, or deletes; suspected duplicates are returned for manual review.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const [products, variants, offers, listings] = await Promise.all([
      readAll("commerce_products", "id,source_key,title_ja,active"),
      readAll("commerce_variants", "id,product_id,source_variant_key,sku"),
      readAll("supplier_offers", "id,variant_id,supplier_code,supplier_product_id,supplier_variant_id"),
      readAll("channel_listings", "id,variant_id,channel,external_product_id,external_variant_id,external_sku,status"),
    ]);

    const report = {
      ok: true,
      phase: "commerce_duplicate_audit",
      readOnly: true,
      counts: {
        commerceProducts: products.length,
        commerceVariants: variants.length,
        supplierOffers: offers.length,
        channelListings: listings.length,
      },
      duplicates: {
        productSourceKey: duplicateGroups(products, (r) => String(r.source_key ?? "").trim(), ["id", "source_key", "title_ja", "active"]),
        productNormalizedTitle: duplicateGroups(products, (r) => String(r.title_ja ?? "").normalize("NFKC").toLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, ""), ["id", "source_key", "title_ja", "active"]),
        variantProductSourceKey: duplicateGroups(variants, (r) => {
          const productId = String(r.product_id ?? "").trim();
          const sourceKey = String(r.source_variant_key ?? "").trim();
          return productId && sourceKey ? productId + "::" + sourceKey : "";
        }, ["id", "product_id", "source_variant_key", "sku"]),
        supplierOfferIdentity: duplicateGroups(offers, (r) => {
          const supplier = String(r.supplier_code ?? "").trim().toLowerCase();
          const product = String(r.supplier_product_id ?? "").trim();
          const variant = String(r.supplier_variant_id ?? "").trim();
          return supplier && product && variant ? [supplier, product, variant].join("::") : "";
        }, ["id", "variant_id", "supplier_code", "supplier_product_id", "supplier_variant_id"]),
        channelVariant: duplicateGroups(listings, (r) => {
          const channel = String(r.channel ?? "").trim().toLowerCase();
          const variantId = String(r.variant_id ?? "").trim();
          return channel && variantId ? channel + "::" + variantId : "";
        }, ["id", "variant_id", "channel", "external_product_id", "external_variant_id", "external_sku", "status"]),
        channelExternalProduct: duplicateGroups(listings, (r) => {
          const channel = String(r.channel ?? "").trim().toLowerCase();
          const externalId = String(r.external_product_id ?? "").trim();
          return channel && externalId ? channel + "::" + externalId : "";
        }, ["id", "variant_id", "channel", "external_product_id", "external_variant_id", "external_sku", "status"]),
        channelExternalVariant: duplicateGroups(listings, (r) => {
          const channel = String(r.channel ?? "").trim().toLowerCase();
          const externalId = String(r.external_variant_id ?? "").trim();
          return channel && externalId ? channel + "::" + externalId : "";
        }, ["id", "variant_id", "channel", "external_product_id", "external_variant_id", "external_sku", "status"]),
      },
    };

    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "commerce_duplicate_audit",
      readOnly: true,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown_error",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
