import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isShopifyConfigured } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

const WOMENS_PRODUCT_PATTERNS = [
  /skincare|skin care|serum|moisturizer|face cream|sunscreen|toner|essence|retinol|niacinamide|acne patch|pore|facial mask/i,
  /beauty|cosmetic|makeup|lipstick|lip gloss|lip tint|blush|mascara|eyelash|eyeliner|highlighter/i,
  /gua sha|face roller|led mask|cleansing brush|makeup brush|beauty device|nail lamp|nail drill/i,
  /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|straightener|hair clip|hair claw/i,
  /women'?s|womens|women|dress|skirt|cardigan|blouse|bodysuit|leggings|activewear|sports bra|bralette|shapewear/i,
  /handbag|crossbody bag|tote bag|jewelry|earrings?|necklace|bracelet|hair accessory/i,
  /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor/i,
  /bra organizer|makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|portable steamer/i,
];
function isWomensProductTitle(title: unknown): boolean { return typeof title === "string" && WOMENS_PRODUCT_PATTERNS.some((pattern) => pattern.test(title)); }

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const db = createSupabaseAdminClient();
  const [listings, supply, recentReverify] = await Promise.all([
    db.from("shop_listings").select("id,published,pipeline_stage,pipeline_status,pipeline_reason,shopify_product_id,shopify_sync_status,inventory,orderable,tracking_available,selling_price,image_url").limit(1000),
    db.from("supplier_listings").select("id,title,identity_status,identity_method,verification_status,orderable,inventory_confirmed,inventory,tracking_available,api_available,supplier_variant_id,supplier_product_id").eq("supplier", "cj").limit(2000),
    db.from("cron_runs").select("started_at,finished_at,processed,failed,metadata,status").eq("job_name", "cj-identity-reverify-cursor").order("started_at", { ascending: false }).limit(5),
  ]);
  if (listings.error) return NextResponse.json({ ok: false, error: listings.error.message }, { status: 500 });
  if (supply.error) return NextResponse.json({ ok: false, error: supply.error.message }, { status: 500 });
  if (recentReverify.error) return NextResponse.json({ ok: false, error: recentReverify.error.message }, { status: 500 });
  const rows = listings.data ?? [];
  const cj = supply.data ?? [];
  const live = rows.filter((row) => row.published === true && row.pipeline_stage === "PUBLISHED" && row.pipeline_status === "published" && row.pipeline_reason === "sales_test_gate_passed" && Number(row.inventory) > 0 && row.orderable === true && row.tracking_available === true && Number(row.selling_price) > 0 && typeof row.image_url === "string" && /^https?:\/\//.test(row.image_url));
  const linkedCj = cj.filter((row) => row.identity_status === "linked" && row.identity_method && row.verification_status === "verified" && row.orderable === true && row.inventory_confirmed === true && Number(row.inventory) > 0 && row.tracking_available === true && row.api_available === true && row.supplier_product_id && row.supplier_variant_id);
  const womensCandidates = cj.filter((row) => isWomensProductTitle(row.title));
  const womensCanonicalReady = linkedCj.filter((row) => isWomensProductTitle(row.title));
  const womensMissingVariant = womensCandidates.filter((row) => !row.supplier_variant_id).length;
  const womensRecoverable = womensCandidates.filter((row) => row.supplier_product_id && row.verification_status !== "unavailable").length;
  const womensBlocked = womensCandidates.length - womensCanonicalReady.length;
  return NextResponse.json({
    ok: true,
    shopifyConfigured: isShopifyConfigured(),
    storefrontContract: "published + sales_test_gate_passed + shopify_synced + in_stock + orderable + trackable",
    shopListings: { inspected: rows.length, live: live.length, published: rows.filter((row) => row.published === true).length, shopifySynced: rows.filter((row) => row.shopify_sync_status === "synced").length },
    cjSupply: {
      inspected: cj.length,
      canonicalLinkedReady: linkedCj.length,
      supplyDiscovered: cj.filter((row) => row.identity_status === "supply_discovered").length,
      retryable: cj.filter((row) => row.verification_status === "retryable").length,
      womens: { candidates: womensCandidates.length, canonicalLinkedReady: womensCanonicalReady.length, blocked: womensBlocked, missingVariant: womensMissingVariant, recoverable: womensRecoverable },
    },
    reverify: recentReverify.data ?? [],
    blockers: [
      ...(!isShopifyConfigured() ? ["shopify_credentials_missing"] : []),
      ...(live.length === 0 ? ["no_gate_passed_shopify_ready_listing"] : []),
      ...(linkedCj.length === 0 ? ["no_canonical_linked_cj_supply"] : []),
      ...(womensCanonicalReady.length === 0 && womensCandidates.length > 0 ? ["no_canonical_linked_womens_cj_supply"] : []),
      ...(womensMissingVariant > 0 ? ["womens_supplier_variant_recovery_pending"] : []),
    ],
  }, { headers: { "Cache-Control": "no-store" } });
}
