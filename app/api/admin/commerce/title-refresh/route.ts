import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isSpecificJapaneseProductTitle, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ProductRow = { id: string; title_ja: string | null; metadata: Record<string, unknown> | null };
type VariantRow = { id: string; product_id: string; title_ja: string | null };

const hasEnglishWords = (value: string) => /[A-Za-z]{2,}/.test(value.replace(/\b(?:PU|PC|USB|LED|UV|A4|Type-C|iPhone|Huawei|PHOERA)\b/gi, ""));

/**
 * Renames products whose Japanese title is shared with other products, using
 * the source-grounded localizeProductTitle mapping (never the current title).
 * POST { apply: false } → plan. POST { apply: true, productIds, limit } → saves
 * product/variant titles for planned ids only, logs each rename to
 * commerce_events, and re-syncs those variants to Shopify and BASE so the three
 * storefronts show the same name. Never deletes or unpublishes.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  let body: { apply?: unknown; productIds?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const limit = Math.max(1, Math.min(15, Math.floor(Number(body.limit) || 10)));
  const requested = new Set(Array.isArray(body.productIds) ? body.productIds.map(String) : []);
  if (apply && requested.size === 0) return NextResponse.json({ ok: false, error: "apply_requires_product_ids_from_dry_run" }, { status: 400 });

  const db = createSupabaseAdminClient();
  const products: ProductRow[] = [];
  for (let from = 0; ; from += 1000) {
    if (from >= 50_000) return NextResponse.json({ ok: false, error: "commerce_products_scan_incomplete" }, { status: 500 });
    const { data, error } = await db.from("commerce_products").select("id,title_ja,metadata").eq("active", true).order("id", { ascending: true }).range(from, from + 999);
    if (error) return NextResponse.json({ ok: false, error: "commerce_products_read_failed", detail: error.message }, { status: 500 });
    products.push(...((data ?? []) as ProductRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const titleCount = new Map<string, number>();
  for (const product of products) {
    const key = String(product.title_ja ?? "").normalize("NFKC").trim();
    titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
  }
  const plan = products.flatMap((product) => {
    const current = String(product.title_ja ?? "").normalize("NFKC").trim();
    if ((titleCount.get(current) ?? 0) < 2) return [];
    const metadata = product.metadata ?? {};
    const source = [metadata.sourceTitle, metadata.source_title, metadata.originalTitle].find((value) => typeof value === "string" && value.trim());
    const next = typeof source === "string" ? localizeProductTitle(source) : null;
    if (!next || next === current || !isSpecificJapaneseProductTitle(next) || !isPublishableCatalogTitle(next) || hasEnglishWords(next)) return [];
    return [{ productId: product.id, from: current, to: next, sourceTitle: String(source).slice(0, 160) }];
  });
  if (!apply) {
    const after = new Map(titleCount);
    for (const item of plan) {
      after.set(item.from, (after.get(item.from) ?? 1) - 1);
      after.set(item.to, (after.get(item.to) ?? 0) + 1);
    }
    return NextResponse.json({
      ok: true,
      readOnly: true,
      activeProducts: products.length,
      sharedTitleGroupsBefore: [...titleCount.values()].filter((n) => n > 1).length,
      sharedTitleGroupsAfter: [...after.values()].filter((n) => n > 1).length,
      renames: plan.length,
      plan,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const selected = plan.filter((item) => requested.has(item.productId)).slice(0, limit);
  const results: Array<{ productId: string; to: string; ok: boolean; variantIds: string[]; error: string | null }> = [];
  const now = () => new Date().toISOString();
  for (const item of selected) {
    try {
      const { data: variants, error: variantError } = await db.from("commerce_variants").select("id,product_id,title_ja").eq("product_id", item.productId);
      if (variantError) throw new Error("variant_read_failed:" + variantError.message);
      const { error: productError } = await db.from("commerce_products").update({ title_ja: item.to, updated_at: now() }).eq("id", item.productId);
      if (productError) throw new Error("product_title_save_failed:" + productError.message);
      for (const variant of (variants ?? []) as VariantRow[]) {
        const suffix = String(variant.title_ja ?? "").match(/（[^）]*）$/u)?.[0] ?? "";
        const { error } = await db.from("commerce_variants").update({ title_ja: item.to + suffix, updated_at: now() }).eq("id", variant.id);
        if (error) throw new Error("variant_title_save_failed:" + error.message);
      }
      await db.from("commerce_events").upsert({
        event_key: "title_refresh:" + item.productId + ":" + item.to,
        event_type: "title_refresh",
        entity_type: "commerce_product",
        entity_id: item.productId,
        status: "ok",
        detail: item,
      }, { onConflict: "event_key", ignoreDuplicates: true });
      results.push({ productId: item.productId, to: item.to, ok: true, variantIds: ((variants ?? []) as VariantRow[]).map((v) => v.id), error: null });
    } catch (error) {
      results.push({ productId: item.productId, to: item.to, ok: false, variantIds: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  // Push the saved titles to both channels so all storefronts show the same name.
  const variantIds = results.flatMap((r) => r.variantIds);
  const sync = variantIds.length
    ? await Promise.all((["shopify", "base"] as const).map(async (channel) => {
      try {
        const result = await syncCommerceListings(channel, variantIds.length, false, variantIds);
        return { channel, processed: result.processed, failed: result.failed, errors: result.results.filter((r: { ok?: boolean }) => !r.ok).slice(0, 5) };
      } catch (error) {
        return { channel, processed: 0, failed: variantIds.length, errors: [(error instanceof Error ? error.message : String(error)).slice(0, 200)] };
      }
    }))
    : [];
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: failed === 0,
    readOnly: false,
    selected: selected.length,
    renamed: results.filter((r) => r.ok).length,
    failed,
    remaining: plan.length - results.filter((r) => r.ok).length,
    results,
    sync,
  }, { headers: { "Cache-Control": "no-store" } });
}
