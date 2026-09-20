import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "id is required" },
        { status: 400 },
      );
    }

    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_observations")
      .select("id, value, signal_type, observed_at, metadata, product_id")
      .eq("id", id)
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      row: data,
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
