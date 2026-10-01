import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  persistCjSupplyIntelligence,
  resolveMarketplaceIdentity,
} from "@/lib/intelligence/persist-cj-supply-intelligence";

const CURSOR_JOB = "cj-identity-reverify-cursor";

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

/**
 * Re-check existing CJ supply that was discovered without marketplace
 * identity. A marketplace bestseller with the same barcode may have been
 * observed after the CJ variant was first verified. Promotion is delegated to
 * resolveMarketplaceIdentity, which only accepts a CJ variant barcode that
 * exactly and uniquely matches one marketplace record's JAN/GTIN/EAN/UPC;
 * pid, vid, SKU, title and image are never treated as identity evidence.
 * Traversal is resumable through a persisted id cursor.
 */
export async function reverifyCjSupplyIdentities(options: {
  limit?: number;
  deadlineAt?: number;
} = {}): Promise<CjIdentityReverifyResult> {
  const db = createSupabaseAdminClient();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
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
    .eq("verification_status", "verified")
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

  let lastId: string | null = null;
  for (const row of rows ?? []) {
    if (Date.now() >= deadlineAt) break;
    lastId = String(row.id);
    result.checked += 1;
    try {
      const identity = await resolveMarketplaceIdentity({
        db,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
      });
      if (!identity) {
        result.noUniqueBarcodeMatch += 1;
        continue;
      }

      // Rebuild the supply evidence for the canonical market product from the
      // supply facts recorded at verification time; never invent economics.
      const { data: intelligence } = await db
        .from("product_intelligence")
        .select("image_url,metadata")
        .eq("product_id", String(row.product_id))
        .maybeSingle();
      const metadata = (intelligence?.metadata ?? {}) as Record<string, unknown>;
      const cost = num(row.cost);
      const shippingCost = num(row.shipping_cost);
      const inventory = num(row.inventory);
      const fxRate = num(metadata.fx_rate);
      const sellingPriceJpy = num(metadata.selling_price_jpy);
      const imageUrl = typeof intelligence?.image_url === "string" ? intelligence.image_url : "";
      if (cost === null || shippingCost === null || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) {
        result.missingEconomics += 1;
        continue;
      }

      await persistCjSupplyIntelligence({
        productId: String(row.product_id),
        title: String(row.title ?? ""),
        imageUrl,
        cost,
        shippingCost,
        supplierListingId: String(row.id),
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        inventory,
        query: typeof metadata.query === "string" ? metadata.query : "identity_reverify",
        fxRate,
        sellingPriceJpy,
      }, { identity });
      result.promoted += 1;
      result.promotedListings.push({ supplierListingId: String(row.id), bestsellerId: identity.bestsellerId, method: identity.method });
    } catch (rowError) {
      result.errors.push({ supplierListingId: String(row.id), error: rowError instanceof Error ? rowError.message : String(rowError) });
    }
  }

  // Wrap around once the whole verified backlog has been traversed.
  const fetched = rows ?? [];
  const reachedEnd = fetched.length < limit && (fetched.length === 0 || lastId === String(fetched.at(-1)?.id));
  result.nextCursor = reachedEnd ? null : lastId ?? afterId;
  const now = new Date().toISOString();
  await db.from("cron_runs").insert({
    job_name: CURSOR_JOB,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: result.checked,
    failed: result.errors.length,
    metadata: { afterId: result.nextCursor, promoted: result.promoted },
  });
  return result;
}
