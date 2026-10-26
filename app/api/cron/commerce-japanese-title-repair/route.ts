import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isSpecificJapaneseProductTitle, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { syncCommerceListings } from "@/lib/commerce/publish";
import { japaneseCommerceDescription } from "@/lib/commerce/japanese-copy.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

type ProductRow = {
  id: string;
  title_ja: string | null;
  metadata: Record<string, unknown> | null;
};
type VariantRow = {
  id: string;
  title_ja: string | null;
  product_id: string;
  commerce_products: ProductRow | ProductRow[] | null;
};

const hasEnglishWords = (value: unknown) => typeof value === "string" && /[A-Za-z]{2,}/.test(value.replace(/\b(?:PU|PC|USB|LED|UV|A4|Type-C|iPhone|Huawei|PHOERA)\b/gi, ""));
const asProduct = (value: VariantRow["commerce_products"]): ProductRow | null =>
  Array.isArray(value) ? value[0] ?? null : value ?? null;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  // Supabase's default response cap is 1,000 rows. Page through the entire
  // active catalog so a large English backlog cannot be falsely reported as done.
  const allRows: VariantRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("commerce_variants")
      .select("id,title_ja,product_id,commerce_products!inner(id,title_ja,metadata,active)")
      .eq("commerce_products.active", true)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) return NextResponse.json({
      ok: false,
      error: "title_repair_candidates_read_failed",
      offset,
      detail: error.message,
    }, { status: 500 });
    const page = (data ?? []) as unknown as VariantRow[];
    allRows.push(...page);
    if (page.length < pageSize) break;
  }

  const byProduct = new Map<string, { product: ProductRow; title: string; variants: VariantRow[] }>();
  const unmapped: string[] = [];
  for (const raw of allRows) {
    const product = asProduct(raw.commerce_products);
    if (!product) continue;
    if (isSpecificJapaneseProductTitle(raw.title_ja) && isSpecificJapaneseProductTitle(product.title_ja) && !hasEnglishWords(raw.title_ja) && !hasEnglishWords(product.title_ja)) continue;
    const metadata = product.metadata ?? {};
    // Metadata may be absent on older imported products. Fall back only to
    // the persisted source title fields; the same localization quality gate
    // still rejects generic or unsupported guesses.
    const sourceCandidates = [
      metadata.sourceTitle, metadata.source_title, metadata.originalTitle,
      raw.title_ja, product.title_ja,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const localized = sourceCandidates
      .map((sourceTitle) => localizeProductTitle(sourceTitle))
      .find((title) => Boolean(title && isSpecificJapaneseProductTitle(title) && !hasEnglishWords(title))) ?? null;
    if (!localized) {
      unmapped.push(raw.product_id);
      continue;
    }
    const current = byProduct.get(product.id) ?? { product, title: localized, variants: [] };
    current.variants.push(raw);
    byProduct.set(product.id, current);
  }

  const variants = [...byProduct.values()].flatMap((entry) => entry.variants);
  const variantIds = [...new Set(variants.map((variant) => variant.id))];
  if (variantIds.length === 0) {
    return NextResponse.json({ ok: unmapped.length === 0, repairedProducts: 0, repairedVariants: 0, unmappedProducts: [...new Set(unmapped)], message: "英語混在タイトルの修復対象はありません。" });
  }

  // Persist source-grounded Japanese titles before publishing. The publisher reads
  // canonical titles from the DB, so syncing first can deadlock on the very title
  // validation error this repair is intended to fix. Sale eligibility gates remain
  // enforced by syncCommerceListings; a failed external sync is reported separately.
  for (const entry of byProduct.values()) {
    const { error: productUpdateError } = await db.from("commerce_products")
      .update({ title_ja: entry.title, description_ja: japaneseCommerceDescription(entry.title), updated_at: new Date().toISOString() })
      .eq("id", entry.product.id);
    if (productUpdateError) throw new Error("title_repair_product_save_failed:" + productUpdateError.message);
    for (const variant of entry.variants) {
      const suffix = String(variant.title_ja ?? "").match(/（[^）]*）$/u)?.[0] ?? "";
      const variantTitle = entry.title + suffix;
      const { error: variantUpdateError } = await db.from("commerce_variants")
        .update({ title_ja: variantTitle, updated_at: new Date().toISOString() })
        .eq("id", variant.id);
      if (variantUpdateError) throw new Error("title_repair_variant_save_failed:" + variantUpdateError.message);
    }
  }

  const [base, shopify] = await Promise.all([
    syncCommerceListings("base", variantIds.length, false, variantIds),
    syncCommerceListings("shopify", variantIds.length, false, variantIds),
  ]);
  const bothSucceeded = Number(base.failed ?? 0) === 0 && Number(shopify.failed ?? 0) === 0;
  const result = {
    ok: bothSucceeded && unmapped.length === 0,
    repairedProducts: byProduct.size,
    repairedVariants: variantIds.length,
    variantIds,
    base: { processed: base.processed ?? base.published ?? 0, failed: base.failed ?? 0 },
    shopify: { processed: shopify.processed ?? shopify.published ?? 0, failed: shopify.failed ?? 0 },
    unmappedProducts: [...new Set(unmapped)],
    databaseTitlesSaved: true,
  };
  console.log("[TRACER JAPANESE TITLE REPAIR]", JSON.stringify({
    ok: result.ok, repairedProducts: result.repairedProducts, repairedVariants: result.repairedVariants,
    baseFailed: result.base.failed, shopifyFailed: result.shopify.failed, unmappedCount: result.unmappedProducts.length,
    baseErrors: (base.results ?? []).filter((item: { ok?: boolean }) => !item.ok).slice(0, 5).map((item: { variantId?: string; error?: string; missingEvidence?: string[] }) => ({ variantId: item.variantId, error: item.error, missingEvidence: item.missingEvidence ?? [] })),
    shopifyErrors: (shopify.results ?? []).filter((item: { ok?: boolean }) => !item.ok).slice(0, 5).map((item: { variantId?: string; error?: string; missingEvidence?: string[] }) => ({ variantId: item.variantId, error: item.error, missingEvidence: item.missingEvidence ?? [] })),
  }));
  return NextResponse.json(result, { status: result.ok ? 200 : 207 });
}
