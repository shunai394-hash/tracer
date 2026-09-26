import { NextResponse } from "next/server";
import { createBaseItem } from "@/lib/channels/base";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data: listings, error } = await supabase
      .from("shop_listings")
      .select("id,title,description,selling_price,image_url,published")
      .eq("published", true)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw new Error(error.message);

    const results = [];

    for (const listing of listings ?? []) {
      if (listing.selling_price === null) {
        results.push({
          id: listing.id,
          ok: false,
          error: "selling_price_unknown",
        });
        continue;
      }

      try {
        const base = await createBaseItem({
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock: 1,
          visible: true,
        });

        results.push({
          id: listing.id,
          ok: true,
          base,
        });
      } catch (error) {
        results.push({
          id: listing.id,
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      attempted: results.length,
      published: results.filter((item) => item.ok).length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
