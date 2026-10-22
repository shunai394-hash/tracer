import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ListingRow = {
  id: string;
  title: string | null;
  supplier_name: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  product_id: string | null;
  supplier_listing_id: string | null;
  published: boolean | null;
  archived_at: string | null;
  base_item_id: string | number | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  created_at: string | null;
};

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * Read-only catalog duplicate audit. Supplier parent IDs group variants that
 * may belong to one product; exact parent+variant matches are the stronger
 * duplicate signal. This endpoint deliberately never mutates listings or
 * channel publications.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("groups") ?? 100);
  const groupLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 100;

  try {
    const db = createSupabaseAdminClient();
    const rows: ListingRow[] = [];
    const pageSize = 1000;
    let complete = false;

    for (let page = 0; page < 50; page += 1) {
      const from = page * pageSize;
      const { data, error } = await db
        .from("shop_listings")
        .select("id,title,supplier_name,supplier_product_id,supplier_variant_id,product_id,supplier_listing_id,published,archived_at,base_item_id,shopify_product_id,shopify_variant_id,created_at")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error("SHOP_LISTINGS_READ_FAILED");
      const batch = (data ?? []) as ListingRow[];
      rows.push(...batch);
      if (batch.length < pageSize) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      return NextResponse.json(
        { ok: false, complete: false, error: "SHOP_LISTINGS_SCAN_INCOMPLETE", scanned: rows.length },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    type Group = {
      supplier: string;
      supplierProductId: string;
      count: number;
      publishedCount: number;
      activeCount: number;
      distinctVariantCount: number;
      exactVariantDuplicateExtraRows: number;
      distinctTitleCount: number;
      titles: string[];
      variants: Array<{
        supplierVariantId: string | null;
        count: number;
        listingIds: string[];
        publishedCount: number;
        baseMappedCount: number;
        shopifyMappedCount: number;
      }>;
      listings: Array<{
        id: string;
        title: string | null;
        productId: string | null;
        supplierListingId: string | null;
        supplierVariantId: string | null;
        published: boolean;
        archived: boolean;
        baseItemId: string | number | null;
        shopifyProductId: string | null;
        shopifyVariantId: string | null;
      }>;
    };

    const groups = new Map<string, Group>();
    let missingSupplierIdentity = 0;
    let publishedRows = 0;
    let activeRows = 0;
    for (const row of rows) {
      const supplier = normalized(row.supplier_name);
      const parentId = String(row.supplier_product_id ?? "").trim();
      const variantId = String(row.supplier_variant_id ?? "").trim();
      if (row.published === true) publishedRows += 1;
      if (!row.archived_at) activeRows += 1;
      if (!supplier || !parentId) {
        missingSupplierIdentity += 1;
        continue;
      }

      const key = JSON.stringify([supplier, parentId]);
      let group = groups.get(key);
      if (!group) {
        group = {
          supplier,
          supplierProductId: parentId,
          count: 0,
          publishedCount: 0,
          activeCount: 0,
          distinctVariantCount: 0,
          exactVariantDuplicateExtraRows: 0,
          distinctTitleCount: 0,
          titles: [],
          variants: [],
          listings: [],
        };
        groups.set(key, group);
      }
      group.count += 1;
      if (row.published === true) group.publishedCount += 1;
      if (!row.archived_at) group.activeCount += 1;
      if (row.title?.trim()) group.titles.push(row.title.trim());

      let variant = group.variants.find((item) => item.supplierVariantId === (variantId || null));
      if (!variant) {
        variant = {
          supplierVariantId: variantId || null,
          count: 0,
          listingIds: [],
          publishedCount: 0,
          baseMappedCount: 0,
          shopifyMappedCount: 0,
        };
        group.variants.push(variant);
      }
      variant.count += 1;
      variant.listingIds.push(row.id);
      if (row.published === true) variant.publishedCount += 1;
      if (row.base_item_id !== null && row.base_item_id !== undefined && String(row.base_item_id).trim()) variant.baseMappedCount += 1;
      if (row.shopify_product_id || row.shopify_variant_id) variant.shopifyMappedCount += 1;

      group.listings.push({
        id: row.id,
        title: row.title,
        productId: row.product_id,
        supplierListingId: row.supplier_listing_id,
        supplierVariantId: variantId || null,
        published: row.published === true,
        archived: Boolean(row.archived_at),
        baseItemId: row.base_item_id,
        shopifyProductId: row.shopify_product_id,
        shopifyVariantId: row.shopify_variant_id,
      });
    }

    const duplicateGroups = [...groups.values()]
      .filter((group) => group.count > 1)
      .map((group) => {
        group.distinctVariantCount = group.variants.filter((item) => item.supplierVariantId !== null).length;
        group.exactVariantDuplicateExtraRows = group.variants.reduce((sum, item) => sum + Math.max(0, item.count - 1), 0);
        group.titles = [...new Set(group.titles)];
        group.distinctTitleCount = group.titles.length;
        group.variants.sort((a, b) => b.count - a.count || String(a.supplierVariantId).localeCompare(String(b.supplierVariantId)));
        return group;
      })
      .sort((a, b) => b.count - a.count || a.supplier.localeCompare(b.supplier) || a.supplierProductId.localeCompare(b.supplierProductId));

    const parentExtraRows = duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0);
    const exactVariantDuplicateExtraRows = duplicateGroups.reduce((sum, group) => sum + group.exactVariantDuplicateExtraRows, 0);
    return NextResponse.json({
      ok: true,
      complete: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      summary: {
        totalRows: rows.length,
        publishedRows,
        activeRows,
        rowsMissingSupplierIdentity: missingSupplierIdentity,
        distinctSupplierParentProducts: groups.size,
        supplierParentGroupsWithMultipleRows: duplicateGroups.length,
        extraRowsWithinRepeatedParentGroups: parentExtraRows,
        exactParentAndVariantDuplicateExtraRows: exactVariantDuplicateExtraRows,
        note: "Repeated parent IDs with distinct variant IDs are variant grouping candidates, not safe deletion candidates. No records or external listings were changed.",
      },
      groups: duplicateGroups.slice(0, groupLimit),
      returnedGroups: Math.min(groupLimit, duplicateGroups.length),
      totalDuplicateGroups: duplicateGroups.length,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, complete: false, error: message.includes("SHOP_LISTINGS") ? message : "DUPLICATE_AUDIT_FAILED" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
