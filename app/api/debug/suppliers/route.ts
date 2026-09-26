import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("supplier_listings")
    .select(
      "id,supplier,bestseller_id,external_id,title,asin,jan,gtin,ean,upc,mpn,cost,shipping_cost,currency,tracking_available,api_available,identity_method,identity_status,identity_confidence,configured,created_at,fetched_at,metadata",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  const summary = rows.reduce(
    (acc, row) => {
      const status = row.identity_status ?? "null";
      acc.identityStatus[status] = (acc.identityStatus[status] ?? 0) + 1;
      const method = row.identity_method ?? "null";
      acc.identityMethod[method] = (acc.identityMethod[method] ?? 0) + 1;
      return acc;
    },
    {
      identityStatus: {} as Record<string, number>,
      identityMethod: {} as Record<string, number>,
    },
  );

  return NextResponse.json({
    ok: true,
    count: rows.length,
    summary,
    rows,
  });
}
