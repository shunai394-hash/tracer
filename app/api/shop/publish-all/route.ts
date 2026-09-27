import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const supabase = createSupabaseAdminClient();

  const { data: listings, error: readError } = await supabase
    .from("shop_listings")
    .select("id, selection_reasons, published")
    .eq("published", true);

  if (readError) {
    return NextResponse.json(
      { ok: false, stage: "read", error: readError.message },
      { status: 500 },
    );
  }

  const ids = (listings ?? [])
    .filter((row) => {
      const reasons = Array.isArray(row.selection_reasons)
        ? row.selection_reasons.map(String)
        : [];
      return reasons.includes("catalog_opening");
    })
    .map((row) => row.id);

  if (ids.length === 0) {
    return NextResponse.json({
      ok: true,
      unpublished: 0,
    });
  }

  const { data, error: updateError } = await supabase
    .from("shop_listings")
    .update({
      published: false,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .select("id");

  if (updateError) {
    return NextResponse.json(
      { ok: false, stage: "update", error: updateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    unpublished: data?.length ?? 0,
  });
}
