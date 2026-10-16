import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { searchCJProducts, getCJProductDetail, fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, calculateCJFreight } from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { upsertSupplierOffer, recalculatePrice } from "@/lib/commerce/core";
import { selectRotatingVariantBatch } from "@/lib/commerce/variant-batch";
import { japaneseCommerceDescription } from "@/lib/commerce/japanese-copy.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

function japaneseCommerceComplianceBlockReason(title: string, productType?: string | null): string | null {
  const source = (String(title ?? "") + " " + String(productType ?? "")).toLowerCase();
  if (/high temperature disinfection cabinet|disinfection cabinet/.test(source)) {
    return "japan_compliance_unverified_disinfection_cabinet";
  }
  return null;
}

function japaneseCommerceTitle(title: string, productType?: string | null, variantNames: string[] = []): string | null {
  const source = (String(title ?? "") + " " + String(productType ?? "")).toLowerCase();

  const normalizedTitle = String(title ?? "").trim().toLowerCase();
  if (/^women handbag$/.test(normalizedTitle) && variantNames.length === 1) {
    const variant = String(variantNames[0] ?? "").toLowerCase();
    if (/gold/.test(variant)) return "ゴールドカラーのレディースハンドバッグ";
    if (/silver/.test(variant)) return "シルバーカラーのレディースハンドバッグ";
  }
  const rules: Array<[RegExp, string]> = [
    [/women role play hair accessories|role play hair accessories/, "レディース コスプレ用ヘアアクセサリー"],
    [/hair tie|rubber band.*hair|hair rope/, "レディース ヘアゴム・ヘアロープ"],
    [/color changing in the sun.*acetate shark clip|acetate shark clip.*shark clip/, "日光で色が変わるアセテート製シャーククリップ"],
    [/pu leather headband.*ponytail clip|ponytail clip.*pu leather headband/, "PUレザー調ヘッドバンド付きポニーテールクリップ"],
    [/double bangs.*hairpin|double bangs.*hairband/, "ダブルバング風ヘアアクセサリー"],
    [/gold alloy hair clips.*geometric|geometric openwork clips/, "幾何学模様のメタルヘアクリップ"],
    [/metal hair clips.*pearl.*rhinestone|pearl.*rhinestone.*hairpins/, "パール・ラインストーン付きメタルヘアクリップ"],
    [/women vintage pu handbag|vintage pu handbag/, "ヴィンテージPUレザーハンドバッグ"],
    [/new fashion personalized handbag/, "パーソナライズドハンドバッグ"],
    [/high temperature disinfection cabinet/, "美容器具用高温消毒キャビネット"],
    [/8 pcs makeup brushes|makeup brushes suit portable/, "携帯用メイクブラシ8本セット"],
    [/eyelash.*comb.*tweezers|tweezers.*eyelash/, "コーム付きまつげピンセット"],
    [/facial beauty tools.*ems|ems.*beauty equipment/, "EMSフェイスケア機器"],
    [/mushroom.*powder puff|powder puff.*mushroom/, "きのこ型メイクパフ"],
    [/women.*hair accessories|hair accessories.*women/, "レディース ヘアアクセサリー"],
    [/fan brush/, "メイク用ファンブラシ"],
    [/fan brush|makeup brush|make-up brush|cosmetic brush|tartaric acid brush/, "メイクブラシ"],
    [/hair claw|hair clip/, "ヘアクリップ"],
    [/headband|hair band/, "ヘアバンド"],
    [/hair brush|detangling brush/, "ヘアブラシ"],
    [/crescent.*(?:metal buckle|small round bag)|(?:metal buckle|small round bag).*crescent/, "メタルバックル付きラウンドバッグ"],
    [/crescent|small round bag/, "ラウンドハンドバッグ"],
    [/women.*handbag|handbag.*women/, "レディースハンドバッグ"],
    [/crossbody bag/, "斜めがけバッグ"],
    [/shoulder bag/, "ショルダーバッグ"],
    [/tote bag|tote/, "トートバッグ"],
    [/clutch bag|clutch/, "クラッチバッグ"],
    [/handbag|purse/, "ハンドバッグ"],
    [/bag strap/, "バッグストラップ"],
    [/face roller/, "フェイスローラー"],
    [/phone case|mobile phone case|iphone case|smartphone case/, "スマートフォンケース"],
    [/pet collar|dog leash|cat collar|pet leash/, "ペット用首輪・リード"],
    [/pet toy|dog toy|cat toy/, "ペット用おもちゃ"],
    [/pet accessory|pet accessories|dog accessory|cat accessory|pet supplies/, "ペット用品"],
    [/kitchen organizer|kitchen storage|spice rack|drawer organizer/, "キッチン収納用品"],
    [/travel organizer|packing cube|luggage organizer|travel pouch/, "旅行用収納ポーチ"],
    [/necklace|earring|bracelet|jewelry/, "アクセサリー"],
    [/beauty tool|makeup|cosmetic/, "美容ツール"],
  ];
  const specific = rules.find(([pattern]) => pattern.test(source));
  return specific?.[1] ?? localizeProductTitle(title, productType);
}

function japaneseVariantSuffix(nameEn: unknown): string {
  const source = String(nameEn ?? "").toLowerCase();
  const colorCount = source.match(/\b([0-9]+)\s*color\b/);
  if (colorCount) return "（" + colorCount[1] + "色）";
  const styleNumber = source.match(/\b([0-9]+)\s*\.?\s*style\b/);
  if (styleNumber) return "（スタイル" + styleNumber[1] + "）";
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

/** Durable exclusion record so a zero-import run can be rechecked without deleting supplier evidence. */
async function recordCjExclusion(identity: string, reason: string, detail: Record<string, unknown>) {
  const db = createSupabaseAdminClient();
  const eventKey = ("cj-exclusion:" + identity + ":" + reason).slice(0, 240);
  const { error } = await db.from("commerce_events").upsert({
    event_key: eventKey,
    event_type: "cj_import_exclusion",
    entity_type: "cj_variant",
    entity_id: identity.slice(0, 200),
    status: "excluded",
    detail: { reason, ...detail, recordedAt: new Date().toISOString() },
  }, { onConflict: "event_key" });
  return error?.message ?? null;
}

/** New clean-catalog CJ importer. Bounded per run and idempotent by supplier-native product/variant IDs. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const url = new URL(request.url);
  // Keep discovery aligned with the user's catalog priorities:
  // women's bags first, then beauty tools, then hair accessories.
  const queryOptions = [
    "women handbag", "beauty tools", "hair accessories women",
  ];
  const explicitQuery = url.searchParams.get("q");
  const discoveryBucket = Math.floor(Date.now() / 600_000);
  const query = (explicitQuery || queryOptions[discoveryBucket % queryOptions.length]).trim().slice(0, 100);
  // Rotate pages as well as query categories; otherwise a 10-minute cron keeps
  // revisiting page 1 and catalog growth stalls after the first few search hits.
  const page = Math.min(1000, Math.max(1, Number(url.searchParams.get("page") || (discoveryBucket % 10) + 1)));
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 4)));
  const variantBatchLimit = Math.min(6, Math.max(1, Number(url.searchParams.get("variantLimit") || 5)));
  const variantRunSlot = Math.floor(Date.now() / 600_000);
  const fx = await getObservedUsdToJpyRate();
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", imported: 0 }, { status: 503 });
  }

  const stats = { searched: 0, products: 0, variantsAvailable: 0, variants: 0, offers: 0, priced: 0, complianceBlocked: 0, skipped: 0, errors: [] as string[] };
  try {
    type ImportCandidate = { id: string; title: string; productType?: string | null; imageUrl?: string | null };
    const requestedProductIds = url.searchParams.has("productIds")
      ? [...new Set((url.searchParams.get("productIds") ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d{10,22}$/.test(id)))].slice(0, limit)
      : [];
    if (url.searchParams.has("productIds") && requestedProductIds.length === 0) {
      return NextResponse.json({ ok: false, error: "invalid_product_ids", imported: 0 }, { status: 400 });
    }
    const forcedDetails = new Map<string, Awaited<ReturnType<typeof getCJProductDetail>>>();
    let candidates: ImportCandidate[] = [];
    if (requestedProductIds.length > 0) {
      for (const id of requestedProductIds) {
        const detail = await getCJProductDetail(id);
        if (!detail) {
          stats.skipped++;
          stats.errors.push("requested_product_detail_missing:" + id);
          continue;
        }
        forcedDetails.set(id, detail);
        candidates.push({ id, title: detail.title, productType: detail.productType, imageUrl: detail.imageUrl });
      }
      stats.searched = candidates.length;
    } else {
      const results = await searchCJProducts(query, { page, size: Math.min(20, limit * 2) });
      stats.searched = results.products.length;
      const db = createSupabaseAdminClient();
      const { data: knownProducts, error: knownProductsError } = await db
        .from("commerce_products").select("source_key").like("source_key", "cj:%").limit(5000);
      if (knownProductsError) throw new Error("known_cj_catalog_read_failed:" + knownProductsError.message);
      const knownParentIds = new Set((knownProducts ?? []).map((row) => {
        const key = String(row.source_key ?? "");
        return key.startsWith("cj:") ? key.slice(3) : "";
      }).filter(Boolean));
      const uniqueSearchProducts = new Map<string, ImportCandidate>();
      for (const item of results.products) {
        const id = String(item.id ?? "").trim();
        if (/^\d{10,22}$/.test(id) && !uniqueSearchProducts.has(id)) uniqueSearchProducts.set(id, item);
      }
      // Prefer never-imported CJ parents so search pages containing existing products
      // cannot consume the entire per-run batch and stall catalog growth.
      const newCandidates = [...uniqueSearchProducts.values()].filter((item) => !knownParentIds.has(item.id));
      let scanPage = page + 1;
      while (newCandidates.length < limit && scanPage <= page + 2) {
        const extra = await searchCJProducts(query, { page: scanPage, size: Math.min(20, limit * 2) });
        stats.searched += extra.products.length;
        for (const item of extra.products) {
          const id = String(item.id ?? "").trim();
          if (!/^\d{10,22}$/.test(id) || uniqueSearchProducts.has(id)) continue;
          uniqueSearchProducts.set(id, item);
          if (!knownParentIds.has(id)) newCandidates.push(item);
        }
        scanPage += 1;
      }
      const fallbackCandidates = [...uniqueSearchProducts.values()].filter((item) => knownParentIds.has(item.id));
      candidates = [...newCandidates, ...fallbackCandidates].slice(0, limit);
      // Prioritize previously failed, syntactically valid CJ parent IDs so transient
      // API failures can be retried instead of leaving those offers errored forever.
      try {
        const [{ data: failedOffers, error: failedOffersError }, { data: listingErrors, error: listingErrorsError }] = await Promise.all([
          db.from("supplier_offers")
            .select("supplier_product_id")
            .eq("supplier_code", "cj")
            .eq("source_status", "error")
            .order("updated_at", { ascending: true })
            .limit(30),
          db.from("channel_listings")
            .select("variant_id")
            .eq("status", "error")
            .like("last_error", "supplier_offer_no_longer_fulfillable:%")
            .order("updated_at", { ascending: true })
            .limit(20),
        ]);
        const listingVariantIds = [...new Set((listingErrors ?? []).map((row) => String(row.variant_id ?? "")).filter(Boolean))];
        const { data: listingOffers, error: listingOffersError } = listingVariantIds.length
          ? await db.from("supplier_offers").select("supplier_product_id").eq("supplier_code", "cj").in("variant_id", listingVariantIds.slice(0, 20))
          : { data: [], error: null };
        if (failedOffersError || listingErrorsError || listingOffersError) {
          stats.errors.push("failed_offer_recovery_read:" + (failedOffersError?.message ?? listingErrorsError?.message ?? listingOffersError?.message ?? "read_failed").slice(0, 120));
        } else {
          const seen = new Set(candidates.map((item) => item.id));
          const listingIds = (listingOffers ?? []).map((row) => String(row.supplier_product_id ?? "").trim());
          const erroredIds = (failedOffers ?? []).map((row) => String(row.supplier_product_id ?? "").trim());
          const recoveryIds = [...new Set([...listingIds, ...erroredIds])]
            .filter((id) => /^\d{10,22}$/.test(id) && !seen.has(id)).slice(0, 2);
          for (const id of recoveryIds) {
            const detail = await getCJProductDetail(id);
            if (!detail) {
              stats.skipped++;
              continue;
            }
            forcedDetails.set(id, detail);
            candidates.push({ id, title: detail.title, productType: detail.productType, imageUrl: detail.imageUrl });
            seen.add(id);
          }
        }
      } catch (recoveryError) {
        stats.errors.push("failed_offer_recovery:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)).slice(0, 120));
      }
    }
    for (const candidate of candidates) {
      try {
        const detail = forcedDetails.get(candidate.id) ?? await getCJProductDetail(candidate.id);
        if (!detail) { stats.skipped++; continue; }
        const variants = await fetchCJProductVariants(candidate.id);
        if (!variants.length) { stats.skipped++; continue; }
        stats.products++;
        stats.variantsAvailable += variants.length;
        // Rotate through every child variant across 10-minute importer slots.
        // Keep each run bounded while avoiding a permanent first-two-variants bias.
        const variantBatch = selectRotatingVariantBatch(variants, variantBatchLimit, variantRunSlot);
        for (const variant of variantBatch) {
          try {
            if (!variant.vid) { stats.skipped++; continue; }
            // Always resolve the exact live VID. A non-empty productId in a
            // product-scoped response may be stale or point at a backup parent.
            const exactVariant = await fetchCJVariantByVid(variant.vid);
            if (!exactVariant || exactVariant.vid !== variant.vid || !String(exactVariant.productId ?? "").trim()) {
              stats.skipped++;
              const reason = "canonical_supplier_product_id_unresolved";
              stats.errors.push(reason + ":" + candidate.id + ":" + variant.vid);
              const logError = await recordCjExclusion(candidate.id + ":" + variant.vid, reason, { catalogProductId: candidate.id, variantId: variant.vid });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const supplierProductId = String(exactVariant.productId).trim();
            const cost = Number(exactVariant.sellPrice);
            if (!Number.isFinite(cost) || cost <= 0) {
              stats.skipped++;
              const reason = "canonical_supplier_variant_price_unresolved";
              stats.errors.push(reason + ":" + supplierProductId + ":" + exactVariant.vid);
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, reason, { catalogProductId: candidate.id, supplierProductId, variantId: exactVariant.vid });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const canonicalDetail = supplierProductId === candidate.id ? detail : await getCJProductDetail(supplierProductId);
            if (!canonicalDetail) {
              stats.skipped++;
              stats.errors.push("canonical_supplier_product_detail_missing:" + supplierProductId);
              continue;
            }
            // CJ enforces one request per second per account. Do not issue stock and freight
            // requests concurrently; parallel requests cause HTTP 429 and waste the quota window.
            let stockResult: PromiseSettledResult<Awaited<ReturnType<typeof fetchCJVariantStock>>>;
            try {
              stockResult = { status: "fulfilled", value: await fetchCJVariantStock(variant.vid) };
            } catch (reason) {
              stockResult = { status: "rejected", reason };
            }
            let freightResult: PromiseSettledResult<Awaited<ReturnType<typeof calculateCJFreight>>>;
            try {
              freightResult = {
                status: "fulfilled",
                value: await calculateCJFreight(variant.vid, { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 }),
              };
            } catch (reason) {
              freightResult = { status: "rejected", reason };
            }
            const stock = stockResult.status === "fulfilled" ? stockResult.value : null;
            const shipping = freightResult.status === "fulfilled" ? freightResult.value : null;
            if (stockResult.status === "rejected") stats.errors.push("stock:" + candidate.id + ":" + String(stockResult.reason).slice(0, 100));
            if (freightResult.status === "rejected") stats.errors.push("freight:" + candidate.id + ":" + String(freightResult.reason).slice(0, 100));
            // A failed/unknown live lookup is not evidence that a previously verified offer is invalid.
            // Preserve its last known evidence; the freshness gate will stop publication once it expires.
            // Do not overwrite it with inventory=0, shipping=0, or sourceStatus=error on transient API failures.
            if (stock === null || shipping === null) {
              stats.skipped++;
              const reason = stock === null ? "supplier_stock_unconfirmed" : "japan_freight_unconfirmed";
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, reason, {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
                stockKnown: stock !== null,
                shippingKnown: shipping !== null,
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const complianceBlockReason = japaneseCommerceComplianceBlockReason(canonicalDetail.title, canonicalDetail.productType);
            const title = japaneseCommerceTitle(canonicalDetail.title, canonicalDetail.productType, supplierProductId === candidate.id ? variants.flatMap((item) => typeof item.nameEn === "string" && item.nameEn.trim().length > 0 ? [item.nameEn] : []) : []) || (supplierProductId === candidate.id ? japaneseCommerceTitle(candidate.title, candidate.productType) : null);
            if (!title) {
              stats.skipped++;
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, "japanese_title_unavailable", {
                catalogProductId: candidate.id,
                sourceTitle: canonicalDetail.title,
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const saved = await upsertSupplierOffer({
              sourceKey: "cj:" + supplierProductId,
              titleJa: title,
              descriptionJa: japaneseCommerceDescription(title),
              metadata: { sourceTitle: canonicalDetail.title, sourceProductType: canonicalDetail.productType ?? null },
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
                inventory: complianceBlockReason || stock === null ? 0 : Math.max(0, Math.floor(stock)), shipTo: "JP",
                trackingSupported: !complianceBlockReason,
                sourceStatus: !complianceBlockReason && stock !== null && shipping !== null ? "verified" : "error",
                lastCheckedAt: new Date().toISOString(),
                rawData: { query, page, catalogProductId: candidate.id, productId: supplierProductId, variantId: exactVariant.vid, stockKnown: stock !== null, shippingKnown: shipping !== null, fxRate: fx.rate, complianceBlockReason },
              },
            });
            stats.variants++;
            stats.offers++;
            if (complianceBlockReason) {
              stats.complianceBlocked++;
              stats.skipped++;
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, complianceBlockReason, {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
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
