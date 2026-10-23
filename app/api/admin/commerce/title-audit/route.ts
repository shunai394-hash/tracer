import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Read-only: active products whose Japanese title is shared by other distinct
 * products, with the supplier source title so renaming rules can be written
 * from evidence. Never writes.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const rows: Array<{ id: string; source_key: string; title_ja: string | null; metadata: Record<string, unknown> | null }> = [];
  for (let from = 0; ; from += 1000) {
    if (from >= 50_000) return NextResponse.json({ ok: false, error: "commerce_products_scan_incomplete" }, { status: 500 });
    const { data, error } = await db.from("commerce_products")
      .select("id,source_key,title_ja,metadata")
      .eq("active", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return NextResponse.json({ ok: false, error: "commerce_products_read_failed", detail: error.message }, { status: 500 });
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = String(row.title_ja ?? "").normalize("NFKC").trim();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const shared = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([title, members]) => ({
      title,
      products: members.length,
      members: members.map((row) => {
        const metadata = row.metadata ?? {};
        const source = [metadata.sourceTitle, metadata.source_title, metadata.originalTitle].find((value) => typeof value === "string" && value.trim());
        return { productId: row.id, sourceKey: row.source_key, sourceTitle: typeof source === "string" ? source.slice(0, 200) : null };
      }),
    }));
  return NextResponse.json({
    ok: true,
    readOnly: true,
    activeProducts: rows.length,
    distinctTitles: groups.size,
    sharedTitleGroups: shared.length,
    productsWithSharedTitle: shared.reduce((sum, group) => sum + group.products, 0),
    groups: shared,
  }, { headers: { "Cache-Control": "no-store" } });
}
