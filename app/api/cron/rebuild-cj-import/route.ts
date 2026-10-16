import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  searchCJProducts,
  getCJProductDetail,
  fetchCJProductVariants,
  fetchCJVariantByVid,
  fetchCJVariantStock,
  calculateCJFreight,
} from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { quoteSellingPrice } from "@/lib/rebuild/commerce-core";
import { upsertSupplierOffer, recalculatePrice } from "@/lib/commerce/core";

export const runtime = "nodejs";
export const maxDuration = 300;

function titleJa(title: string, type?: string | null): string {
  const source = (title + " " + (type ?? "")).toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/handbag|purse|crossbody|shoulder bag|tote bag/, "レディースバッグ"],
    [/hair clip|hair claw|headband|hair band/, "ヘアアクセサリー"],
    [/makeup brush|cosmetic brush|beauty tool|face roller/, "美容ツール"],
    [/earring|necklace|bracelet/, "アクセサリー"],
    [/phone case|mobile phone case/, "スマートフォンケース"],
  ];
  return rules.find(([pattern]) => pattern.test(source))?.[1] ?? localizeProductTitle(title, type) ?? "";
}

function variantJa(name: unknown): string {
  const source = String(name ?? "").toLowerCase();
  const colors: Array<[RegExp, string]> = [
    [/black/, "ブラック"], [/white/, "ホワイト"], [/pink/, "ピンク"],
    [/blue/, "ブルー"], [/green/, "グリーン"], [/red/, "レッド"],
    [/purple/, "パープル"], [/beige/, "ベージュ"], [/brown/, "ブラウン"],
    [/gray|grey/, "グレー"], [/silver/, "シルバー"], [/gold/, "ゴールド"],
  ];
  const matches = colors.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
  return matches.length ? "（" + [...new Set(matches)].join("・") + "）" : "";
}

/** Imports bounded CJ samples into the new canonical schema; safe to rerun. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const params = new URL(request.url).searchParams;
  const queryOptions = ["women handbag", "beauty tools", "hair accessories women", "phone case"];
  const query = (params.get("q") || queryOptions[Math.floor(Date.now() / 1_800_000) % queryOptions.length]).trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Number(params.get("page") || 1)));
  const limit = Math.min(10, Math.max(1, Number(params.get("limit") || 3)));
  const fx = await getObservedUsdToJpyRate();
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", imported: 0 }, { status: 503 });
  }

  const db = createSupabaseAdminClient();
  const stats = { searched: 0, products: 0, variants: 0, priced: 0, skipped: 0, errors: [] as string[] };
  try {
    const found = await searchCJProducts(query, { page, size: Math.min(20, limit * 2) });
    stats.searched = found.products.length;
    for (const candidate of found.products.slice(0, limit)) {
      try {
        const initialDetail = await getCJProductDetail(candidate.id);
        if (!initialDetail) { stats.skipped++; continue; }
        const variants = await fetchCJProductVariants(candidate.id);
        if (!variants.length) { stats.skipped++; continue; }
        for (const candidateVariant of variants.slice(0, 5)) {
          try {
            if (!candidateVariant.vid) { stats.skipped++; continue; }
            const exact = await fetchCJVariantByVid(candidateVariant.vid);
            const supplierProductId = String(exact?.productId ?? "").trim();
            if (!exact || exact.vid !== candidateVariant.vid || !supplierProductId) {
              stats.skipped++;
              stats.errors.push("exact_supplier_variant_unresolved:" + candidate.id + ":" + candidateVariant.vid);
              continue;
            }
            const detail = supplierProductId === candidate.id ? initialDetail : await getCJProductDetail(supplierProductId);
            const title = detail ? titleJa(detail.title, detail.productType) : "";
            const sourceCost = Number(exact.sellPrice);
            if (!detail || !title.trim() || !Number.isFinite(sourceCost) || sourceCost <= 0) {
              stats.skipped++;
              stats.errors.push("supplier_detail_or_price_missing:" + supplierProductId + ":" + exact.vid);
              continue;
            }
            const [stockResult, freightResult] = await Promise.allSettled([
              fetchCJVariantStock(exact.vid),
              calculateCJFreight(exact.vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
            ]);
            const stock = stockResult.status === "fulfilled" ? stockResult.value : null;
            const shipping = freightResult.status === "fulfilled" ? freightResult.value : null;
            const productKey = "cj:" + supplierProductId;
            const { data: product, error: productError } = await db.from("tc_products").upsert({
              source_key: productKey,
              title_ja: title,
              description_ja: title + "。仕入先の最新仕様・配送条件を注文前に再確認します。",
              image_urls: detail.imageUrl ? [detail.imageUrl] : [],
              category: detail.productType ?? null,
              active: true,
              updated_at: new Date().toISOString(),
            }, { onConflict: "source_key" }).select("id").single();
            if (productError || !product) throw new Error("canonical_product_upsert_failed:" + (productError?.message ?? "no_row"));

            const offer = {
              product_id: product.id,
              supplier_code: "cj",
              supplier_product_id: supplierProductId,
              supplier_variant_id: exact.vid,
              supplier_title: String(exact.nameEn ?? ""),
              source_url: "https://cjdropshipping.com/product/" + encodeURIComponent(supplierProductId),
              currency: "USD",
              source_cost: sourceCost,
              shipping_cost: shipping === null ? 0 : Math.max(0, Number(shipping)),
              stock_quantity: stock === null ? 0 : Math.max(0, Math.floor(Number(stock))),
              ship_to: "JP",
              orderable: stock !== null && Number(stock) > 0 && shipping !== null && Number(shipping) >= 0,
              tracking_available: shipping !== null,
              supplier_payload: { query, page, fxRate: fx.rate, stockKnown: stock !== null, shippingKnown: shipping !== null, variantSku: exact.sku ?? null, barcode: exact.barcode ?? null, variantName: exact.nameEn ?? null },
              last_checked_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            const { error: variantError } = await db.from("tc_supplier_variants").upsert(offer, {
              onConflict: "supplier_code,supplier_product_id,supplier_variant_id",
            });
            if (variantError) throw new Error("supplier_variant_upsert_failed:" + variantError.message);

            // Quote in JPY, but retain the supplier's native USD costs in the supplier offer.
            if (stock !== null && Number(stock) > 0 && shipping !== null && Number(shipping) >= 0) {
              const quote = quoteSellingPrice({
                sourceCost: Math.ceil(sourceCost * fx.rate),
                shippingCost: Math.ceil(Number(shipping) * fx.rate),
                marketplaceFeeRate: 0.1,
                paymentFeeRate: 0,
                targetMarginRate: 0.2,
              });
              const { data: savedOffer, error: savedOfferError } = await db.from("tc_supplier_variants")
                .select("id")
                .eq("supplier_code", "cj")
                .eq("supplier_product_id", supplierProductId)
                .eq("supplier_variant_id", exact.vid)
                .single();
              if (savedOfferError || !savedOffer) throw new Error("supplier_variant_id_lookup_failed:" + (savedOfferError?.message ?? "no_row"));
              const { error: priceError } = await db.from("tc_prices").upsert({
                supplier_variant_id: savedOffer.id,
                currency: "JPY",
                selling_price: quote.sellingPrice,
                marketplace_fee_rate: 0.1,
                payment_fee_rate: 0,
                target_margin_rate: 0.2,
                landed_cost_jpy: quote.landedCost,
                estimated_fees_jpy: quote.estimatedFees,
                estimated_profit_jpy: quote.estimatedProfit,
                estimated_margin_rate: quote.estimatedMarginRate,
                fx_rate: fx.rate,
                calculated_at: new Date().toISOString(),
              }, { onConflict: "supplier_variant_id" });
              if (priceError) throw new Error("price_upsert_failed:" + priceError.message);

              // Feed the existing BASE/Shopify publication and paid-order fulfillment
              // pipeline as well. Those routes use commerce_products/variants/offers,
              // so importing only tc_* would leave the storefront pipeline empty.
              const observedAt = new Date().toISOString();
              const legacy = await upsertSupplierOffer({
                sourceKey: productKey,
                titleJa: title,
                descriptionJa: title + "。日本向け送料を含む価格です。",
                category: detail.productType ?? null,
                imageUrl: detail.imageUrl,
                sourceUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(supplierProductId),
                sourceVariantKey: supplierProductId + ":" + exact.vid,
                variantTitleJa: title + variantJa(exact.nameEn),
                sku: exact.sku ?? null,
                attributes: { supplierProductId, supplierVariantId: exact.vid, variantName: exact.nameEn ?? null },
                metadata: { source: "rebuild-cj-import", query, page, exactVariantVerified: true },
                offer: {
                  supplierCode: "cj",
                  supplierProductId,
                  supplierVariantId: exact.vid,
                  supplierUrl: "https://cjdropshipping.com/product/" + encodeURIComponent(supplierProductId),
                  currency: "USD",
                  unitCost: sourceCost,
                  shippingCost: Number(shipping),
                  inventory: Math.floor(Number(stock)),
                  shipTo: "JP",
                  trackingSupported: true,
                  sourceStatus: "verified",
                  lastCheckedAt: observedAt,
                  rawData: { query, page, fxRate: fx.rate, stockVerified: true, japanFreightVerified: true, variantSku: exact.sku ?? null, variantBarcode: exact.barcode ?? null },
                },
              });
              await recalculatePrice({
                variantId: legacy.variantId,
                offerId: legacy.offerId,
                exchangeRateToJpy: fx.rate,
                feeRate: 0.1,
                targetMarginRate: 0.2,
              });
              stats.priced++;
            } else {
              stats.skipped++;
            }
            stats.variants++;
          } catch (error) {
            stats.errors.push("variant:" + String(candidateVariant.vid) + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
          }
        }
        stats.products++;
      } catch (error) {
        stats.errors.push("product:" + candidate.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
      }
    }
    await db.from("tc_sync_events").insert({
      entity_type: "catalog",
      action: "cj_import",
      status: stats.errors.length ? "error" : "success",
      details: { query, page, fxRate: fx.rate, stats },
    });
    return NextResponse.json({ ok: stats.errors.length === 0, query, page, fxRate: fx.rate, stats }, { status: stats.errors.length ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, query, page, stats, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
