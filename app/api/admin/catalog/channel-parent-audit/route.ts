import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ChannelRow = {
  id: string;
  channel: string;
  status: string | null;
  external_product_id: string | null;
  external_variant_id: string | null;
  variant_id: string;
  commerce_variants: {
    id: string;
    source_variant_key: string | null;
    product_id: string;
    commerce_products: {
      id: string;
      source_key: string | null;
      title_ja: string | null;
    } | null;
  } | null;
};

function clean(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim();
}

/**
 * Read-only report that identifies canonical parent products published as
 * multiple external products on the same sales channel. It never changes
 * canonical records or external listings.
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
    const rows: ChannelRow[] = [];
    const pageSize = 1000;
    let complete = false;

    for (let page = 0; page < 50; page += 1) {
      const from = page * pageSize;
      const { data, error } = await db
        .from("channel_listings")
        .select("id,channel,status,external_product_id,external_variant_id,variant_id,commerce_variants!inner(id,source_variant_key,product_id,commerce_products!inner(id,source_key,title_ja))")
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error("CHANNEL_LISTINGS_READ_FAILED");
      const batch = (data ?? []) as unknown as ChannelRow[];
      rows.push(...batch);
      if (batch.length < pageSize) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      return NextResponse.json(
        { ok: false, complete: false, error: "CHANNEL_LISTINGS_SCAN_INCOMPLETE", scanned: rows.length },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    type Group = {
      channel: string;
      sourceKey: string;
      canonicalProductId: string;
      title: string | null;
      variantIds: Set<string>;
      variantKeys: Set<string>;
      externalProductIds: Set<string>;
      publishedExternalProductIds: Set<string>;
      rows: number;
      publishedRows: number;
      rowsMissingExternalProductId: number;
      rowsMissingExternalVariantId: number;
      statuses: Record<string, number>;
      examples: Array<{
        channelListingId: string;
        variantId: string;
        sourceVariantKey: string | null;
        externalProductId: string | null;
        externalVariantId: string | null;
        status: string | null;
      }>;
    };

    const groups = new Map<string, Group>();
    let rowsMissingCanonicalProduct = 0;

    for (const row of rows) {
      const variant = row.commerce_variants;
      const product = variant?.commerce_products;
      const sourceKey = clean(product?.source_key);
      if (!variant || !product || !sourceKey) {
        rowsMissingCanonicalProduct += 1;
        continue;
      }
      const key = JSON.stringify([row.channel, sourceKey]);
      let group = groups.get(key);
      if (!group) {
        group = {
          channel: row.channel,
          sourceKey,
          canonicalProductId: product.id,
          title: product.title_ja ?? null,
          variantIds: new Set<string>(),
          variantKeys: new Set<string>(),
          externalProductIds: new Set<string>(),
          publishedExternalProductIds: new Set<string>(),
          rows: 0,
          publishedRows: 0,
          rowsMissingExternalProductId: 0,
          rowsMissingExternalVariantId: 0,
          statuses: {},
          examples: [],
        };
        groups.set(key, group);
      }
      group.rows += 1;
      group.variantIds.add(variant.id);
      const sourceVariantKey = clean(variant.source_variant_key);
      if (sourceVariantKey) group.variantKeys.add(sourceVariantKey);
      const externalProductId = clean(row.external_product_id);
      const externalVariantId = clean(row.external_variant_id);
      if (externalProductId) group.externalProductIds.add(externalProductId);
      else group.rowsMissingExternalProductId += 1;
      if (!externalVariantId) group.rowsMissingExternalVariantId += 1;
      const status = clean(row.status) || "unknown";
      group.statuses[status] = (group.statuses[status] ?? 0) + 1;
      if (status === "published") {
        group.publishedRows += 1;
        if (externalProductId) group.publishedExternalProductIds.add(externalProductId);
      }
      if (group.examples.length < 20) {
        group.examples.push({
          channelListingId: row.id,
          variantId: variant.id,
          sourceVariantKey: sourceVariantKey || null,
          externalProductId: externalProductId || null,
          externalVariantId: externalVariantId || null,
          status: row.status,
        });
      }
    }

    const report = [...groups.values()].map((group) => {
      const variantCount = group.variantIds.size;
      const externalProductCount = group.externalProductIds.size;
      const publishedExternalProductCount = group.publishedExternalProductIds.size;
      let classification = "single_variant_or_unpublished";
      if (publishedExternalProductCount > 1) {
        classification = "published_parent_split_across_external_products";
      } else if (publishedExternalProductCount === 1 && variantCount > 1) {
        classification = "published_variants_share_external_product";
      } else if (group.rowsMissingExternalProductId > 0) {
        classification = "external_product_mapping_incomplete";
      } else if (externalProductCount > 1) {
        classification = "multiple_external_products_not_all_published";
      }
      return {
        channel: group.channel,
        sourceKey: group.sourceKey,
        canonicalProductId: group.canonicalProductId,
        title: group.title,
        variantCount,
        distinctSourceVariantKeyCount: group.variantKeys.size,
        externalProductCount,
        publishedExternalProductCount,
        rows: group.rows,
        publishedRows: group.publishedRows,
        rowsMissingExternalProductId: group.rowsMissingExternalProductId,
        rowsMissingExternalVariantId: group.rowsMissingExternalVariantId,
        statuses: group.statuses,
        classification,
        examples: group.examples,
      };
    }).sort((a, b) =>
      b.publishedExternalProductCount - a.publishedExternalProductCount ||
      b.variantCount - a.variantCount ||
      a.channel.localeCompare(b.channel) ||
      a.sourceKey.localeCompare(b.sourceKey)
    );

    const split = report.filter((group) => group.classification === "published_parent_split_across_external_products");
    const incomplete = report.filter((group) => group.classification === "external_product_mapping_incomplete");
    return NextResponse.json({
      ok: true,
      complete: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      summary: {
        channelListingRowsScanned: rows.length,
        canonicalProductsByChannel: report.length,
        parentGroupsSplitAcrossPublishedExternalProducts: split.length,
        groupsWithIncompleteExternalProductMapping: incomplete.length,
        rowsMissingCanonicalProduct,
        note: "A split group is a reconciliation candidate, not an instruction to delete listings. Verify channel capabilities, variant mapping, inventory, and order history before changing external products.",
      },
      groups: report.slice(0, groupLimit),
      returnedGroups: Math.min(groupLimit, report.length),
      totalGroups: report.length,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, complete: false, error: message.includes("CHANNEL_LISTINGS") ? message : "CHANNEL_PARENT_AUDIT_FAILED" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
