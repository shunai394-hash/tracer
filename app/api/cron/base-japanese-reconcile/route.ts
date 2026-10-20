import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isBaseConfigured } from "@/lib/channels/base";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function hasJapanese(value: unknown): boolean {
  return typeof value === "string" && /[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(value);
}

/**
 * Incrementally refresh existing, exact-ID-linked BASE items whose catalog
 * copy is not Japanese. The publisher re-verifies supplier identity and
 * eligibility before editing any external item; this route never creates
 * mappings from titles, prices, or guessed SKUs.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  if (!isBaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(10, Math.max(1, Math.floor(requestedLimit)))
    : 10;

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("shop_listings")
    .select("id,title,description,base_item_id,published,archived_at")
    .eq("published", true)
    .not("base_item_id", "is", null)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1000);

  if (error) {
    return NextResponse.json(
      { ok: false, stage: "read", error: error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const candidates = (data ?? []).filter((row) =>
    !hasJapanese(row.title) || !hasJapanese(row.description),
  );
  const selected = candidates.slice(0, limit).map((row) => String(row.id));
  if (selected.length === 0) {
    return NextResponse.json({
      ok: true,
      scanned: (data ?? []).length,
      candidates: 0,
      attempted: 0,
      message: "既存BASE商品の日本語コピーは、照合済みの対象範囲で修正不要です。",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const result = await publishPublishedListingsToBase(selected.length, selected);
    return NextResponse.json({
      ok: result.failed === 0,
      scanned: (data ?? []).length,
      candidates: candidates.length,
      selectedListingIds: selected,
      ...result,
    }, {
      status: result.failed > 0 ? 207 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    return NextResponse.json({
      ok: false,
      stage: "publish",
      selectedListingIds: selected,
      error: cause instanceof Error ? cause.message : String(cause),
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
