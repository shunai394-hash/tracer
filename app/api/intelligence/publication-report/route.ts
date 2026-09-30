import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

// Read-only exact counts used to verify production publication runs.
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const supabase = createSupabaseAdminClient();
    const count = async (
      label: string,
      build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
    ): Promise<[string, number]> => {
      const { count: value, error } = await build();
      if (error) throw new Error(`${label}: ${error.message}`);
      return [label, value ?? 0];
    };
    const listings = () => supabase.from("shop_listings").select("id", { count: "exact", head: true });
    const cj = () =>
      supabase
        .from("supplier_listings")
        .select("id", { count: "exact", head: true })
        .eq("supplier", "cj")
        .eq("inventory_confirmed", true)
        .eq("price_confirmed", true)
        .gt("inventory", 0)
        .not("supplier_product_id", "is", null)
        .not("supplier_variant_id", "is", null);
    const deliveries = () =>
      supabase.from("newfind_promotion_deliveries").select("listing_id", { count: "exact", head: true });

    const entries = await Promise.all([
      count("shopPublished", () => listings().eq("published", true)),
      count("shopPublishedSupplyFirst", () =>
        listings().eq("published", true).eq("identity_method", "supply_discovered")),
      count("shopPublishedShippingUnknown", () =>
        listings().eq("published", true).is("shipping_cost", null)),
      count("basePublished", () =>
        listings().eq("published", true).not("base_item_id", "is", null).eq("base_publication_status", "published")),
      count("baseItemsTotal", () => listings().not("base_item_id", "is", null)),
      count("cjVerifiedCandidates", () => cj()),
      count("cjVerifiedCandidatesShippingMeasured", () => cj().not("shipping_cost", "is", null).gt("shipping_cost", 0)),
      count("newfindProcessed", () => deliveries().eq("status", "processed")),
      count("newfindSent", () => deliveries().eq("status", "sent")),
      count("newfindPending", () => deliveries().eq("status", "pending")),
      count("newfindFailed", () => deliveries().eq("status", "failed")),
    ]);

    const { data: recentSupplyFirst, error: recentError } = await supabase
      .from("shop_listings")
      .select("id,slug,title,selling_price,shipping_cost,inventory,orderable,published,base_item_id,base_publication_status,base_last_error,pipeline_reason,published_at")
      .eq("identity_method", "supply_discovered")
      .order("published_at", { ascending: false })
      .limit(50);
    if (recentError) throw new Error(recentError.message);

    const { data: recentDeliveries, error: deliveriesError } = await supabase
      .from("newfind_promotion_deliveries")
      .select("listing_id,status,http_status,ack_status,attempts,last_error,updated_at")
      .order("updated_at", { ascending: false })
      .limit(50);
    if (deliveriesError) throw new Error(deliveriesError.message);

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: Object.fromEntries(entries),
      recentSupplyFirst: recentSupplyFirst ?? [],
      recentNewfindDeliveries: recentDeliveries ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
