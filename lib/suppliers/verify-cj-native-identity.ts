import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { calculateCJFreight, fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, getCJProductDetail } from "@/lib/sources/cj/client";
import { CJ_NATIVE_IDENTITY_METHOD, evaluateCjNativeIdentity, type CjNativeIdentityDecision } from "@/lib/procurement/cj-native-identity";

type Db = ReturnType<typeof createSupabaseAdminClient>;

export type CjNativeIdentityCandidate = {
  id: string;
  product_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  title: string | null;
  identity_method: string | null;
  identity_status: string | null;
  metadata: Record<string, unknown> | null;
};

export type CjNativeIdentityLiveReaders = {
  variantByVid: typeof fetchCJVariantByVid;
  productVariants: typeof fetchCJProductVariants;
  productDetail: typeof getCJProductDetail;
  variantStock: typeof fetchCJVariantStock;
  jpFreight: (vid: string) => Promise<number | null>;
};

const defaultReaders: CjNativeIdentityLiveReaders = {
  variantByVid: fetchCJVariantByVid,
  productVariants: fetchCJProductVariants,
  productDetail: getCJProductDetail,
  variantStock: fetchCJVariantStock,
  jpFreight: (vid) => calculateCJFreight(vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1, zip: "1000001" }),
};

async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Observe one CJ supplier listing live and decide CJ-native identity.
 * Every lookup failure becomes "unknown" evidence, which the evaluator rejects.
 */
export async function observeCjNativeIdentity(
  db: Db,
  row: CjNativeIdentityCandidate,
  readers: CjNativeIdentityLiveReaders = defaultReaders,
): Promise<CjNativeIdentityDecision> {
  const pid = String(row.supplier_product_id ?? "").trim();
  const vid = String(row.supplier_variant_id ?? "").trim();

  let duplicateRowCount = 0;
  let listingImageUrl: unknown = null;
  if (pid && vid) {
    const duplicates = await db
      .from("supplier_listings")
      .select("id")
      .eq("supplier", "cj")
      .eq("supplier_product_id", pid)
      .eq("supplier_variant_id", vid)
      .limit(3);
    duplicateRowCount = duplicates.error ? -1 : (duplicates.data ?? []).length;
  }
  if (row.product_id) {
    const intelligence = await db.from("product_intelligence").select("image_url").eq("product_id", row.product_id).maybeSingle();
    listingImageUrl = intelligence.error ? null : intelligence.data?.image_url ?? null;
  }

  const variant = vid ? await attempt(() => readers.variantByVid(vid)) : null;
  const variants = pid ? await attempt(() => readers.productVariants(pid)) : null;
  const detail = pid ? await attempt(() => readers.productDetail(pid)) : null;
  const stock = vid ? await attempt(() => readers.variantStock(vid)) : null;
  const freight = vid ? await attempt(() => readers.jpFreight(vid)) : null;

  return evaluateCjNativeIdentity({
    stored: {
      supplierProductId: row.supplier_product_id,
      supplierVariantId: row.supplier_variant_id,
      listingImageUrl,
      listingTitle: row.title,
      duplicateRowCount,
    },
    live: {
      variant: variant ? { vid: variant.vid, productId: variant.productId, nameEn: variant.nameEn, sellPrice: variant.sellPrice } : null,
      productVariantIds: variants ? variants.map((item) => item.vid) : null,
      productImageUrl: detail?.imageUrl ?? null,
      stock,
      jpFreight: freight,
    },
    observedAt: new Date().toISOString(),
  });
}

/**
 * Record a decision on supplier_listings. A verified proof links the row as
 * cj_native_variant with the live cost, freight and stock it was proven with.
 * A rejected proof only records evidence, except that a row currently linked
 * by cj_native_variant is downgraded so stale proof cannot keep it sellable.
 * Rows linked by marketplace identifiers are never changed by this function.
 */
export async function recordCjNativeIdentity(
  db: Db,
  row: CjNativeIdentityCandidate,
  decision: CjNativeIdentityDecision,
): Promise<{ ok: boolean; error: string | null; changed: "linked" | "downgraded" | "evidence_only" | "skipped_marketplace_linked" }> {
  const metadata = { ...(row.metadata ?? {}), cj_native_identity: decision.evidence };
  const marketplaceLinked = row.identity_status === "linked" && row.identity_method !== CJ_NATIVE_IDENTITY_METHOD;
  if (marketplaceLinked) {
    const { error } = await db.from("supplier_listings").update({ metadata }).eq("id", row.id);
    return { ok: !error, error: error?.message ?? null, changed: "skipped_marketplace_linked" };
  }
  if (decision.verified) {
    const { error } = await db.from("supplier_listings").update({
      identity_method: CJ_NATIVE_IDENTITY_METHOD,
      identity_status: "linked",
      identity_confidence: 1,
      cost: decision.evidence.live_price_usd,
      shipping_cost: decision.evidence.jp_freight_usd,
      currency: "USD",
      inventory: decision.evidence.live_stock,
      price_confirmed: true,
      inventory_confirmed: true,
      verification_status: "verified",
      shipping_status: "verified",
      ship_to: "JP",
      orderable: true,
      tracking_available: true,
      api_available: true,
      verification_error: null,
      last_verified_at: decision.evidence.observed_at,
      metadata,
    }).eq("id", row.id);
    return { ok: !error, error: error?.message ?? null, changed: "linked" };
  }
  if (row.identity_method === CJ_NATIVE_IDENTITY_METHOD) {
    const { error } = await db.from("supplier_listings").update({
      identity_method: "supply_discovered",
      identity_status: "supply_discovered",
      identity_confidence: 0,
      orderable: false,
      verification_error: `cj_native_identity_rejected:${decision.reasons.join(",")}`.slice(0, 500),
      last_verified_at: decision.evidence.observed_at,
      metadata,
    }).eq("id", row.id);
    return { ok: !error, error: error?.message ?? null, changed: "downgraded" };
  }
  const { error } = await db.from("supplier_listings").update({ metadata }).eq("id", row.id);
  return { ok: !error, error: error?.message ?? null, changed: "evidence_only" };
}
