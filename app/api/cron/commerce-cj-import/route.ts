import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { searchCJProducts, getCJProductDetail, fetchCJProductVariants, fetchCJVariantStock, calculateCJFreight } from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { upsertSupplierOffer, recalculatePrice } from "@/lib/commerce/core";

export const runtime = "nodejs";
export const maxDuration = 300;

/** New clean-catalog CJ importer. Bounded per run and idempotent by supplier-native product/variant IDs. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "women handbag").trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Number(url.searchParams.get("page") || 1)));
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 3)));
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
        for (const variant of variants.slice(0, 3)) {
          try {
            const cost = Number(variant.sellPrice);
            if (!variant.vid || !Number.isFinite(cost) || cost <= 0) { stats.skipped++; continue; }
            const [stockResult, freightResult] = await Promise.allSettled([
              fetchCJVariantStock(variant.vid),
              calculateCJFreight(variant.vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
            ]);
            const stock = stockResult.status === "fulfilled" ? stockResult.value : null;
            const shipping = freightResult.status === "fulfilled" ? freightResult.value : null;
            if (stockResult.status === "rejected") stats.errors.push("stock:" + candidate.id + ":" + String(stockResult.reason).slice(0, 100));
            if (freightResult.status === "rejected") stats.errors.push("freight:" + candidate.id + ":" + String(freightResult.reason).slice(0, 100));
            const title = localizeProductTitle(detail.title, detail.productType) || localizeProductTitle(candidate.title, candidate.productType);
            if (!title) { stats.skipped++; continue; }
            const saved = await upsertSupplierOffer({
              sourceKey: "cj:" + candidate.id,
              titleJa: title,
              descriptionJa: title + "。商品仕様・配送条件は仕入先の最新情報に基づき確認してください。",
              category: detail.productType ?? candidate.productType,
              imageUrl: detail.imageUrl ?? candidate.imageUrl,
              sourceUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(candidate.id),
              sourceVariantKey: variant.vid,
              variantTitleJa: variant.nameEn ? title + "（" + variant.nameEn + "）" : title,
              sku: variant.sku,
              attributes: { barcode: variant.barcode, supplierVariantName: variant.nameEn },
              offer: {
                supplierCode: "cj", supplierProductId: variant.productId || candidate.id,
                supplierVariantId: variant.vid, supplierUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(candidate.id),
                currency: "USD", unitCost: cost, shippingCost: shipping ?? 0,
                inventory: stock === null ? 0 : Math.max(0, Math.floor(stock)), shipTo: "JP",
                trackingSupported: true,
                rawData: { query, page, productId: candidate.id, variantId: variant.vid, stockKnown: stock !== null, shippingKnown: shipping !== null, fxRate: fx.rate },
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
