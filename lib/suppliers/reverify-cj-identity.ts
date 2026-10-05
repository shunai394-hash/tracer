import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  persistCjSupplyIntelligence,
  resolveMarketplaceIdentity,
} from "@/lib/intelligence/persist-cj-supply-intelligence";

const CURSOR_JOB = "cj-identity-reverify-cursor";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const CONCURRENCY = 5;

export type CjIdentityReverifyResult = {
  checked: number;
  promoted: number;
  noUniqueBarcodeMatch: number;
  missingEconomics: number;
  errors: Array<{ supplierListingId: string; error: string }>;
  promotedListings: Array<{ supplierListingId: string; bestsellerId: string; method: string }>;
  nextCursor: string | null;
};

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Re-check existing CJ supply that was discovered without marketplace
 * identity. Identity promotion remains evidence-gated: only a unique exact
 * CJ variant barcode -> marketplace JAN/GTIN/EAN/UPC match is accepted.
 * Traversal is resumable through a persisted id cursor.
 */
export async function reverifyCjSupplyIdentities(options: {
  limit?: number;
  deadlineAt?: number;
} = {}): Promise<CjIdentityReverifyResult> {
  const db = createSupabaseAdminClient();
  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  // Respect the caller's budget. A patrol that explicitly asks for five rows
  // must not silently expand to 25 and consume the entire step deadline.
  const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;

  const { data: cursorRow, error: cursorError } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", CURSOR_JOB)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cursorError) throw new Error(`identity reverify cursor read failed: ${cursorError.message}`);

  const afterId = typeof (cursorRow?.metadata as Record<string, unknown> | undefined)?.afterId === "string"
    ? String((cursorRow?.metadata as Record<string, unknown>).afterId)
    : null;

  let query = db
    .from("supplier_listings")
    .select("id,product_id,title,cost,shipping_cost,inventory,supplier_product_id,supplier_variant_id,identity_method,metadata")
    .eq("supplier", "cj")
    .in("verification_status", ["verified", "unverified"])
    .eq("orderable", true)
    .eq("identity_method", "supply_discovered")
    .not("supplier_variant_id", "is", null)
    .not("product_id", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (afterId) query = query.gt("id", afterId);

  const { data: rows, error } = await query;
  if (error) throw new Error(`identity reverify candidate query failed: ${error.message}`);

  const result: CjIdentityReverifyResult = {
    checked: 0,
    promoted: 0,
    noUniqueBarcodeMatch: 0,
    missingEconomics: 0,
    errors: [],
    promotedListings: [],
    nextCursor: null,
  };

  const processRow = async (row: (typeof rows)[number]) => {
    const supplierListingId = String(row.id);
    try {
      const listingMetadata = record(row.metadata);
      const persistedBarcode = typeof listingMetadata.variant_barcode === "string"
        ? listingMetadata.variant_barcode.trim()
        : null;
      const identity = await resolveMarketplaceIdentity({
        db,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        variantBarcode: persistedBarcode,
      });
      if (!identity) return { kind: "no_match" as const, supplierListingId };

      const { data: intelligence } = await db
        .from("product_intelligence")
        .select("image_url,metadata")
        .eq("product_id", String(row.product_id))
        .maybeSingle();
      const metadata = record(intelligence?.metadata);
      const cost = num(row.cost);
      const shippingCost = num(row.shipping_cost);
      const inventory = num(row.inventory);
      const fxRate = num(metadata.fx_rate);
      const sellingPriceJpy = num(metadata.selling_price_jpy);
      const imageUrl = typeof intelligence?.image_url === "string" ? intelligence.image_url : "";
      if (cost === null || shippingCost === null || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) {
        return { kind: "missing_economics" as const, supplierListingId };
      }

      await persistCjSupplyIntelligence({
        productId: String(row.product_id),
        title: String(row.title ?? ""),
        imageUrl,
        cost,
        shippingCost,
        supplierListingId,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        inventory,
        query: typeof metadata.query === "string" ? metadata.query : "identity_reverify",
        fxRate,
        sellingPriceJpy,
        variantBarcode: persistedBarcode,
      }, { identity });

      return {
        kind: "promoted" as const,
        supplierListingId,
        bestsellerId: identity.bestsellerId,
        method: identity.method,
      };
    } catch (rowError) {
      return {
        kind: "error" as const,
        supplierListingId,
        error: rowError instanceof Error ? rowError.message : String(rowError),
      };
    }
  };

  const selectedRows = rows ?? [];
  let processed = 0;
  for (let offset = 0; offset < selectedRows.length; offset += CONCURRENCY) {
    if (Date.now() >= deadlineAt) break;
    const batch = selectedRows.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(processRow));
    for (const item of results) {
      processed += 1;
      result.checked += 1;
      if (item.kind === "promoted") {
        result.promoted += 1;
        result.promotedListings.push({ supplierListingId: item.supplierListingId, bestsellerId: item.bestsellerId, method: item.method });
      } else if (item.kind === "no_match") {
        result.noUniqueBarcodeMatch += 1;
      } else if (item.kind === "missing_economics") {
        result.missingEconomics += 1;
      } else {
        result.errors.push({ supplierListingId: item.supplierListingId, error: item.error });
      }
    }
  }

  // If a row failed transiently, rewind to just before it so the next run
  // retries that row instead of permanently skipping it with the cursor.
  const firstErrorIndex = selectedRows.findIndex((row) =>
    result.errors.some((item) => item.supplierListingId === String(row.id)),
  );
  const lastProcessedId = firstErrorIndex >= 0
    ? firstErrorIndex === 0 ? afterId : String(selectedRows[firstErrorIndex - 1]?.id)
    : processed > 0 ? String(selectedRows[processed - 1]?.id) : afterId;
  result.nextCursor = firstErrorIndex >= 0
    ? lastProcessedId
    : processed < selectedRows.length ? lastProcessedId : selectedRows.length < limit ? null : lastProcessedId;

  const now = new Date().toISOString();
  await db.from("cron_runs").insert({
    job_name: CURSOR_JOB,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: result.checked,
    failed: result.errors.length,
    metadata: {
      afterId: result.nextCursor,
      promoted: result.promoted,
      noUniqueBarcodeMatch: result.noUniqueBarcodeMatch,
      missingEconomics: result.missingEconomics,
    },
  });
  return result;
}
