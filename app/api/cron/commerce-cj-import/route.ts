import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { searchCJProducts, getCJProductDetail, fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, calculateCJFreight } from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { upsertSupplierOffer, recalculatePrice } from "@/lib/commerce/core";

export const runtime = "nodejs";
export const maxDuration = 300;

function japaneseCommerceTitle(title: string, productType?: string | null): string | null {
  const source = (String(title ?? "") + " " + String(productType ?? "")).toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/fan brush|makeup brush|make-up brush|cosmetic brush|tartaric acid brush/, "メイクブラシ"],
    [/hair brush|detangling brush/, "ヘアブラシ"],
    [/hair clip|hair claw|headband|hair band/, "ヘアアクセサリー"],
    [/crossbody bag/, "斜めがけバッグ"],
    [/shoulder bag/, "ショルダーバッグ"],
    [/tote bag|tote/, "トートバッグ"],
    [/clutch bag|clutch/, "クラッチバッグ"],
    [/handbag|purse|shoulder bag|\bbag\b/, "バッグ"],
    [/face roller/, "フェイスローラー"],
    [/beauty tool|makeup|cosmetic/, "美容ツール"],
  ];
  const specific = rules.find(([pattern]) => pattern.test(source));
  return specific?.[1] ?? localizeProductTitle(title, productType);
}

function japaneseVariantSuffix(nameEn: unknown): string {
  const source = String(nameEn ?? "").toLowerCase();
  const colors: Array<[RegExp, string]> = [
    [/yellow/, "イエロー"], [/white/, "ホワイト"], [/black/, "ブラック"],
    [/pink/, "ピンク"], [/blue/, "ブルー"], [/green/, "グリーン"],
    [/red/, "レッド"], [/purple/, "パープル"], [/beige/, "ベージュ"],
    [/brown/, "ブラウン"], [/gray|grey/, "グレー"], [/silver/, "シルバー"],
    [/gold/, "ゴールド"], [/orange/, "オレンジ"], [/navy/, "ネイビー"],
  ];
  const matched = [...new Set(colors.filter(([pattern]) => pattern.test(source)).map(([, ja]) => ja))];
  return matched.length ? "（" + matched.join("・") + "）" : "";
}

/** New clean-catalog CJ importer. Bounded per run and idempotent by supplier-native product/variant IDs. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const queryOptions = ["women handbag", "beauty tools", "hair accessories women"];
  const explicitQuery = url.searchParams.get("q");
  const query = (explicitQuery || queryOptions[Math.floor(Date.now() / 1_800_000) % queryOptions.length]).trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Number(url.searchParams.get("page") || 1)));
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 2)));
  const fx = await getObservedUsdToJpyRate();
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", imported: 0 }, { status: 503 });
  }

  const stats = { searched: 0, products: 0, variants: 0, offers: 0, priced: 0, skipped: 0, errors: [] as string[] };
  try {
    const results = await searchCJProducts(query, { page, size: Math.min(20, limit * 2) });
    stats.searched = results.products.length;
    for (const candidate of results.products.slice(0, limit)) {
      try {
        const detail = await getCJProductDetail(candidate.id);
        if (!detail) { stats.skipped++; continue; }
        const variants = await fetchCJProductVariants(candidate.id);
        if (!variants.length) { stats.skipped++; continue; }
        stats.products++;
        for (const variant of variants.slice(0, 2)) {
          try {
            if (!variant.vid) { stats.skipped++; continue; }
            // Always resolve the exact live VID. A non-empty productId in a
            // product-scoped response may be stale or point at a backup parent.
            const exactVariant = await fetchCJVariantByVid(variant.vid);
            if (!exactVariant || exactVariant.vid !== variant.vid || !String(exactVariant.productId ?? "").trim()) {
              stats.skipped++;
              stats.errors.push("canonical_supplier_product_id_unresolved:" + candidate.id + ":" + variant.vid);
              continue;
            }
            const supplierProductId = String(exactVariant.productId).trim();
            const cost = Number(exactVariant.sellPrice);
            if (!Number.isFinite(cost) || cost <= 0) {
              stats.skipped++;
              stats.errors.push("canonical_supplier_variant_price_unresolved:" + supplierProductId + ":" + exactVariant.vid);
              continue;
            }
            const canonicalDetail = supplierProductId === candidate.id ? detail : await getCJProductDetail(supplierProductId);
            if (!canonicalDetail) {
              stats.skipped++;
              stats.errors.push("canonical_supplier_product_detail_missing:" + supplierProductId);
              continue;
            }
            const [stockResult, freightResult] = await Promise.allSettled([
              fetchCJVariantStock(variant.vid),
              calculateCJFreight(variant.vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
            ]);
            const stock = stockResult.status === "fulfilled" ? stockResult.value : null;
            const shipping = freightResult.status === "fulfilled" ? freightResult.value : null;
            if (stockResult.status === "rejected") stats.errors.push("stock:" + candidate.id + ":" + String(stockResult.reason).slice(0, 100));
            if (freightResult.status === "rejected") stats.errors.push("freight:" + candidate.id + ":" + String(freightResult.reason).slice(0, 100));
            const title = japaneseCommerceTitle(canonicalDetail.title, canonicalDetail.productType) || (supplierProductId === candidate.id ? japaneseCommerceTitle(candidate.title, candidate.productType) : null);
            if (!title) { stats.skipped++; continue; }
            const saved = await upsertSupplierOffer({
              sourceKey: "cj:" + supplierProductId,
              titleJa: title,
              descriptionJa: title + "。商品仕様・配送条件は仕入先の最新情報に基づき確認してください。",
              category: canonicalDetail.productType ?? (supplierProductId === candidate.id ? candidate.productType : null),
              imageUrl: canonicalDetail.imageUrl ?? (supplierProductId === candidate.id ? candidate.imageUrl : null),
              sourceUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(supplierProductId),
              sourceVariantKey: exactVariant.vid,
              variantTitleJa: title + japaneseVariantSuffix(exactVariant.nameEn),
              sku: exactVariant.sku,
              attributes: { barcode: exactVariant.barcode, supplierVariantName: exactVariant.nameEn },
              offer: {
                supplierCode: "cj", supplierProductId,
                supplierVariantId: exactVariant.vid, supplierUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(supplierProductId),
                currency: "USD", unitCost: cost, shippingCost: shipping ?? 0,
                inventory: stock === null ? 0 : Math.max(0, Math.floor(stock)), shipTo: "JP",
                trackingSupported: true,
                sourceStatus: stock !== null && shipping !== null ? "verified" : "error",
                lastCheckedAt: new Date().toISOString(),
                rawData: { query, page, catalogProductId: candidate.id, productId: supplierProductId, variantId: exactVariant.vid, stockKnown: stock !== null, shippingKnown: shipping !== null, fxRate: fx.rate },
              },
            });
            stats.variants++;
            stats.offers++;
            if (stock !== null && stock > 0 && shipping !== null && shipping >= 0) {
              await recalculatePrice({ variantId: saved.variantId, offerId: saved.offerId, exchangeRateToJpy: fx.rate, feeRate: 0.1, targetMarginRate: 0.2 });
              stats.priced++;
            } else {
              stats.skipped++;
            }
          } catch (error) {
            stats.errors.push("variant:" + candidate.id + ":" + variant.vid + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
          }
        }
      } catch (error) {
        stats.errors.push("product:" + candidate.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
      }
    }
    return NextResponse.json({ ok: stats.errors.length === 0, query, page, fxRate: fx.rate, fxSource: fx.source, stats }, { status: stats.errors.length ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, query, page, stats, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
