import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createSupabaseAdminClient();

    const [{ data: recent, error: recentError }, { data: listings, error: listingsError }] =
      await Promise.all([
        supabase
          .from("marketplace_bestsellers")
          .select("id,title,marketplace,rank,pipeline_stage,pipeline_status,pipeline_reason,pipeline_error,pipeline_updated_at")
          .order("pipeline_updated_at", { ascending: false })
          .limit(100),
        supabase
          .from("shop_listings")
          .select("id,title,published,base_item_id,inventory,orderable,pipeline_stage,pipeline_status,pipeline_reason,pipeline_error,pipeline_updated_at")
          .order("pipeline_updated_at", { ascending: false })
          .limit(100),
      ]);

    if (recentError) throw new Error(recentError.message);
    if (listingsError) throw new Error(listingsError.message);

    const stageCounts = new Map<string, number>();
    const reasonCounts = new Map<string, number>();
    for (const row of recent ?? []) {
      const key = `${row.pipeline_stage}:${row.pipeline_status}`;
      stageCounts.set(key, (stageCounts.get(key) ?? 0) + 1);
      if (row.pipeline_reason) {
        reasonCounts.set(row.pipeline_reason, (reasonCounts.get(row.pipeline_reason) ?? 0) + 1);
      }
    }

    const published = (listings ?? []).filter((row) => row.published);
    const basePublished = published.filter((row) => row.base_item_id);
    const orderable = published.filter((row) => row.orderable === true);

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      marketplace: {
        recent: recent ?? [],
        stageCounts: Object.fromEntries(stageCounts),
        reasonCounts: Object.fromEntries(reasonCounts),
      },
      shop: {
        recent: listings ?? [],
        publishedCount: published.length,
        basePublishedCount: basePublished.length,
        orderableCount: orderable.length,
      },
    });
  } catch (error) {
    console.error("[TRACER PIPELINE STATUS ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
