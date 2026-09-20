import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isBrokenText(value: string): boolean {
  return (
    value.includes("\uFFFD") ||
    /(?:Ã.|Â.|â.|å.|æ.|ç.|é.|è.|ê.|ë.|ì.|í.|î.|ï.|ð.|ñ.|ò.|ó.|ô.|õ.|ö.|ø.|ù.|ú.|û.|ü.|ý.|þ.)/.test(
      value,
    )
  );
}

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_observations")
      .select("id, metadata")
      .eq("signal_type", "search_volume")
      .is("product_id", null);

    if (error) {
      throw new Error(error.message);
    }

    let inspected = 0;
    let invalidated = 0;

    for (const row of data ?? []) {
      inspected += 1;

      const metadata =
        row.metadata &&
        typeof row.metadata === "object" &&
        !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};

      const query =
        typeof metadata.query === "string"
          ? metadata.query
          : "";

      if (!query || !isBrokenText(query)) {
        continue;
      }

      const { error: updateError } = await supabase
        .from("demand_observations")
        .update({
          metadata: {
            ...metadata,
            invalid: true,
            invalid_reason: "unrecoverable_encoding",
          },
        })
        .eq("id", row.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      invalidated += 1;
    }

    return NextResponse.json({
      ok: true,
      inspected,
      invalidated,
    });
  } catch (error) {
    console.error("[TRACER DEMAND INVALIDATE ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
