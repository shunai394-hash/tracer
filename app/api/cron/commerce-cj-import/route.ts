import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";
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
    [/happybirth(?:day)?.*flash diamond letter headband|flash diamond letter headband.*happybirth/, "誕生日パーティー用ラインストーン文字カチューシャ"],
    [/hair accessories headband women.*golden ring.*cross stitching.*fabric.*wide|golden ring.*cross stitching.*fabric.*wide.*headband/, "ゴールドリング装飾の幅広クロスステッチヘアバンド"],
    [/cartoon cute girl side clip.*sweet bang hairpin|sweet bang hairpin.*side clip/, "キャラクター風サイドヘアクリップ"],
    [/women headpiece stretch turban|stretch turban.*hair accessories/, "ストレッチ素材のターバン風ヘッドバンド"],
    [/niche high-grade extra long tassel hair accessories|extra long tassel hair accessories/, "ロングタッセル付きヘアアクセサリー"],
    [/shine full rhinestone hairpins.*long tassel.*crystal|rhinestone hairpins.*long tassel.*wedding banquet/, "ラインストーンとロングタッセルの華やかヘアピン"],
    [/wooden handle portable facial treatment brush|portable facial treatment brush.*wooden handle/, "木製ハンドルのフェイスケアブラシ"],
    [/beauty tools scissors cut spartan small straight scissors beard|small straight scissors beard/, "眉・ひげ用ストレートシザー"],
    [/cloud porcelain series eye makeup detail brush|eye makeup detail brush suit beauty tools/, "磁器調ハンドルのアイメイクブラシセット"],
    [/folding silicone solid color beauty tools pad for washing brush|silicone.*pad for washing brush/, "折りたたみ式シリコン製メイクブラシ洗浄パッド"],
    [/fashion personality handmade woven handbag|handmade woven handbag for women/, "手編みデザインのレディースハンドバッグ"],
    [/fashionable snake-print handbag|snake-print handbag for women/, "パイソン柄レディースハンドバッグ"],
    [/fashion large capacity handbag|large capacity handbag for women/, "大容量レディースハンドバッグ"],
    [/women pattern handbag shoulder crossbody|pattern handbag shoulder crossbody bag/, "柄入りショルダー＆クロスボディバッグ"],
    [/affordable luxury fashion cowhide handbag|cowhide handbag women/, "牛革素材のレディースハンドバッグ"],
    [/handmade sheepskin woven handbag|sheepskin woven handbag for women/, "羊革の編み込みレディースハンドバッグ"],
    [/versatile handbag retro canvas|retro canvas women handbag/, "レトロキャンバス地のレディースハンドバッグ"],
    [/fashionable all-match handbag|all-match handbag for women/, "コーデに合わせやすいレディースハンドバッグ"],
    [/women role play hair accessories|role play hair accessories/, "レディース コスプレ用ヘアアクセサリー"],
    [/happybirthday.*diamond.*letter.*headband|diamond letter headband/, "ダイヤモンド風アルファベット付きパーティーヘアバンド"],
    [/golden ring.*cross stitching.*fabric.*wide|cross stitching fabric wide.*headband/, "ゴールドリング風アクセントのワイド布製ヘアバンド"],
    [/cartoon.*side clip.*hairpin|side clip.*bang hairpin/, "キャラクターモチーフの前髪用ヘアクリップ"],
    [/wooden handle.*facial treatment brush|facial treatment brush.*wooden handle/, "木製ハンドルのフェイスケアブラシ"],
    [/scissors.*small straight scissors.*beard|small straight scissors.*beard/, "眉・ひげのお手入れ用ミニストレートシザー"],
    [/women pattern handbag shoulder crossbody|pattern handbag.*crossbody bag/, "柄デザインのレディース斜めがけバッグ"],
    [/affordable luxury.*cowhide handbag|cowhide handbag.*women/, "牛革風素材のレディースハンドバッグ"],
    [/transparent handbag.*mesh embroidery|mesh embroidery.*handbag/, "メッシュ刺繍デザインのクリアハンドバッグ"],
    [/wavy knit handbag|knit handbag.*women/, "ウェーブ編みデザインのニットハンドバッグ"],
    [/handmade beaded handbag|beaded handbag.*women/, "ビーズ装飾のハンドメイド風ハンドバッグ"],
    [/rhinestone irregular handbag|irregular handbag.*rhinestone/, "ラインストーン付きアシンメトリーハンドバッグ"],
    [/paper rope woven handbag|woven handbag.*paper rope/, "ペーパー素材の編み込みハンドバッグ"],
    [/headpiece.*stretch turban|stretch turban.*headwear/, "ストレッチ素材のターバン風ヘッドアクセサリー"],
    [/extra long tassel hair accessories|long tassel.*hair accessories/, "ロングタッセル付きヘアアクセサリー"],
    [/silicone eyeliner aid|eyeliner aid/, "アイライン用シリコンメイク補助具"],
    [/tallow lip balm|lip balm/, "リップバーム"],
    [/facial care double-headed.*beauty needle|beauty needle tools.*4-piece/, "両端タイプのフェイスケアツール4点セット"],
    [/40pc beauty tools|40pc.*face wash makeup/, "フェイスケア・メイクツール40点セット"],
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
  if (!specific) return localizeProductTitle(title, productType);

  // Broad category rules must not override an available source-specific Japanese
  // title. Older versions returned "メイクブラシ" or "レディースハンドバッグ"
  // before localizeProductTitle could apply its more specific source-title rules,
  // creating dozens of indistinguishable storefront cards.
  const categoryOnlyTitles = new Set([
    "レディースハンドバッグ",
    "ハンドバッグ",
    "ショルダーバッグ",
    "斜めがけバッグ",
    "トートバッグ",
    "クラッチバッグ",
    "バッグストラップ",
    "メイクブラシ",
    "メイク用ファンブラシ",
    "ヘアクリップ",
    "ヘアバンド",
    "ヘアブラシ",
    "レディース ヘアアクセサリー",
    "美容ツール",
    "美容・メイクアイテム",
    "スマートフォンケース",
    "ペット用品",
    "キッチン収納用品",
    "旅行用収納ポーチ",
    "アクセサリー",
  ]);
  if (categoryOnlyTitles.has(specific[1])) {
    const sourceSpecificTitle = localizeProductTitle(title, productType);
    if (sourceSpecificTitle && !categoryOnlyTitles.has(sourceSpecificTitle)) {
      return sourceSpecificTitle;
    }
  }
  return specific[1];
}

function japaneseVariantSuffix(nameEn: unknown): string {
  const source = String(nameEn ?? "").toLowerCase();
  const colorCount = source.match(/\b([0-9]+)\s*color\b/);
  if (colorCount) return "（" + colorCount[1] + "色）";
  const styleNumber = source.match(/\b([0-9]+)\s*\.?\s*style\b/);
  if (styleNumber) return "（スタイル" + styleNumber[1] + "）";
  const numberedColor = source.match(/\b(silver|gold|black|white)\s+([0-9]+)\b/);
  if (numberedColor) {
    const color = numberedColor[1] === "silver" ? "シルバー" : numberedColor[1] === "gold" ? "ゴールド" : numberedColor[1] === "black" ? "ブラック" : "ホワイト";
    return "（" + color + "・タイプ" + numberedColor[2] + "）";
  }
  const optionLabels: Array<[RegExp, string]> = [
    [/4pin.*no\s*5.*oblique clip/, "4ピン・No.5斜めクリップ"],
    [/4pin.*no\s*5.*straight clip/, "4ピン・No.5ストレートクリップ"],
    [/4pin.*hook/, "4ピン・フッククリップ"],
    [/without word hook/, "刻印なし・フック"],
    [/no word.*oblique clip/, "刻印なし・斜めクリップ"],
    [/straight clip without words/, "刻印なし・ストレートクリップ"],
    [/standard specifications.*straight clip/, "標準仕様・ストレートクリップ"],
    [/no\s*5.*oblique clip/, "No.5斜めクリップ"],
    [/no\s*5.*straight clip/, "No.5ストレートクリップ"],
    [/no\s*5.*hook/, "No.5フック"],
    [/20\s*pcs?\s*set/, "20点セット"], [/40\s*pcs?\s*set/, "40点セット"],
    [/15\s*pcs?\s*set/, "15点セット"], [/1\s*pcs?\b/, "1点セット"], [/3\s*pcs?\b/, "3点セット"],
    [/5 pieces.*with pu bag/, "5本セット・収納ポーチ付き"],
    [/8 pieces.*with pu bag/, "8本セット・収納ポーチ付き"],
    [/5 pieces.*bare brush/, "5本セット・ブラシのみ"],
    [/8 pieces.*bare brush/, "8本セット・ブラシのみ"],
    [/8 brushes/, "8本セット"], [/8piece set/, "8点セット"],
    [/7 diamonds/, "7粒ダイヤ調"], [/3d patterns/, "3D柄"],
    [/branches pearl snowflake/, "枝モチーフ・パール雪結晶"],
    [/branches rhinestone snowflake/, "枝モチーフ・ラインストーン雪結晶"],
    [/antlers pearl snowflake/, "鹿角モチーフ・パール雪結晶"],
    [/antlers rhinestone snowflake/, "鹿角モチーフ・ラインストーン雪結晶"],
    [/metal flower style/, "メタルフラワー"], [/velvet snowflake style/, "ベルベット雪結晶"],
    [/coffee hawksbill/, "コーヒーべっ甲・4cm"], [/rice hawksbill/, "ライスべっ甲・4cm"],
    [/floral coffee/, "花柄コーヒー・4cm"], [/transparent powder/, "透明パウダー・4cm"],
    [/two rollers/, "2ローラー"], [/scraping face scraping board/, "かっさプレート"],
    [/butterfly long tassel/, "蝶モチーフ"], [/as main image/, "標準デザイン"],
    [/mini peach/, "ピーチ"], [/wisteria color/, "藤色"], [/chestnut color/, "チェスナット"],
    [/cinerous/, "アッシュグレー"], [/square colorful crystals/, "スクエアビジュー"],
    [/colorful crystals/, "カラフルビジュー"], [/long stripes/, "ロングストライプ"],
    [/stripes handmade crochet/, "ストライプ柄"], [/mori style/, "森系デザイン"],
    [/red wine/, "ワインレッド"], [/rose red/, "ローズレッド"],
    [/fluorescent green/, "蛍光グリーン"], [/cream color/, "クリーム"],
    [/skin color/, "スキンカラー"], [/rouge/, "ルージュ"], [/matcha/, "抹茶"],
    [/sunflower/, "サンフラワー"], [/camellia/, "カメリア"],
    [/trilogy/, "トリロジー"], [/rabble/, "ラブル"],
    [/pearl tote gradient/, "パールトート・グラデーション"],
    [/double gradient shoulder/, "ダブルグラデーションショルダー"],
    [/crossbody dumpling bag/, "巾着型ショルダー"],
    [/pearl crossbody bag/, "パールショルダー"], [/pearl tote/, "パールトート"],
  ];
  const option = optionLabels.find(([pattern]) => pattern.test(source));
  if (option) return "（" + option[1] + "）";
  const colors: Array<[RegExp, string]> = [
    [/yellow/, "イエロー"], [/white/, "ホワイト"], [/black/, "ブラック"],
    [/pink/, "ピンク"], [/cyan/, "シアン"], [/blue/, "ブルー"],
    [/fluorescent green/, "蛍光グリーン"], [/green/, "グリーン"],
    [/rose red/, "ローズレッド"], [/red/, "レッド"], [/purple/, "パープル"],
    [/beige/, "ベージュ"], [/khaki/, "カーキ"], [/apricot/, "アプリコット"],
    [/cream/, "クリーム"], [/mocha/, "モカ"], [/brown/, "ブラウン"],
    [/gray|grey/, "グレー"], [/silver/, "シルバー"], [/gold/, "ゴールド"],
    [/orange/, "オレンジ"], [/navy/, "ネイビー"],
  ];
  const matched = [...new Set(colors.filter(([pattern]) => pattern.test(source)).map(([, ja]) => ja))];
  if (matched.length) return "（" + matched.join("・") + "）";
  const trailingOptionCode = source.match(/\b([a-z])$/);
  return trailingOptionCode ? "（タイプ" + trailingOptionCode[1].toUpperCase() + "）" : "";
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
  const db = createSupabaseAdminClient();
  const { data: quotaRun, error: quotaReadError } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", "cj-api-quota-circuit")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (quotaReadError) {
    return NextResponse.json({ ok: false, error: "CJ_QUOTA_CIRCUIT_LOOKUP_FAILED", imported: 0 }, { status: 500 });
  }
  const quotaMetadata = quotaRun?.metadata && typeof quotaRun.metadata === "object" && !Array.isArray(quotaRun.metadata)
    ? quotaRun.metadata as Record<string, unknown>
    : {};
  const blockedUntil = typeof quotaMetadata.blockedUntil === "string" ? quotaMetadata.blockedUntil : null;
  if (isCJQuotaCircuitActive(quotaMetadata)) {
    console.info("[TRACER COMMERCE CJ IMPORT SKIPPED]", {
      reason: "cj_daily_api_points_cooldown",
      retryAfter: blockedUntil,
      imported: 0,
    });
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "cj_daily_api_points_cooldown",
      retryAfter: blockedUntil,
      imported: 0,
    }, { status: 202 });
  }
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
  // Process multiple new parents and child variants per 10-minute slot by default.
  // The per-run caps remain bounded to respect CJ rate limits and the 300-second function timeout.
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 3)));
  const variantBatchLimit = Math.min(6, Math.max(1, Number(url.searchParams.get("variantLimit") || 2)));
  const variantRunSlot = Math.floor(Date.now() / 600_000);
  const fx = await getObservedUsdToJpyRate();
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    console.error("[TRACER COMMERCE CJ IMPORT FAILED]", { reason: "usd_jpy_rate_unavailable", imported: 0 });
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", imported: 0 }, { status: 503 });
  }

  const stats = { searched: 0, products: 0, variantsAvailable: 0, variants: 0, offers: 0, priced: 0, complianceBlocked: 0, skipped: 0, skipReasons: {} as Record<string, number>, errors: [] as string[] };
  const recordSkip = (reason: string) => { stats.skipped++; stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1; };
  try {
    type ImportCandidate = { id: string; title: string; productType?: string | null; imageUrl?: string | null; retryVariantIds?: string[] };
    const requestedProductIds = url.searchParams.has("productIds")
      ? [...new Set((url.searchParams.get("productIds") ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d{10,22}$/.test(id)))].slice(0, limit)
      : [];
    if (url.searchParams.has("productIds") && requestedProductIds.length === 0) {
      return NextResponse.json({ ok: false, error: "invalid_product_ids", imported: 0 }, { status: 400 });
    }
    const forcedDetails = new Map<string, Awaited<ReturnType<typeof getCJProductDetail>>>();
    let candidates: ImportCandidate[] = [];
    const retryOfferByVariantId = new Map<string, { id: string; raw_data: unknown }>();
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
      // Keep missing-publication recovery narrow and separately recheck existing listings
      // whose saved supplier status, stock, or Japan-bound freight evidence is in error.
      const [{ data: erroredOffers, error: erroredOffersError }, { data: staleVerifiedOffers, error: staleVerifiedOffersError }, { data: shopifyRows, error: shopifyRowsError }] = await Promise.all([
        db.from("supplier_offers")
          .select("id,variant_id,supplier_product_id,supplier_variant_id,source_status,raw_data,updated_at,last_checked_at")
          .eq("supplier_code", "cj").eq("source_status", "error")
          .order("updated_at", { ascending: true }).limit(2000),
        // Verified offers also need a bounded refresh once their live stock/freight
        // evidence is older than 24h; otherwise procurement can reject them forever
        // while the importer only retries source_status=error rows.
        db.from("supplier_offers")
          .select("id,variant_id,supplier_product_id,supplier_variant_id,source_status,raw_data,updated_at,last_checked_at")
          .eq("supplier_code", "cj").eq("source_status", "verified")
          .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(2000),
        db.from("channel_listings").select("variant_id").eq("channel", "shopify").limit(5000),
      ]);
      if (erroredOffersError || staleVerifiedOffersError || shopifyRowsError) {
        throw new Error("missing_shopify_offer_recovery_read_failed:" + (erroredOffersError?.message ?? staleVerifiedOffersError?.message ?? shopifyRowsError?.message));
      }
      const shopifyVariantIds = new Set((shopifyRows ?? []).map((row) => String(row.variant_id)));
      const eligibleErroredOffers = (erroredOffers ?? []).filter((offer) => {
        const parentId = String(offer.supplier_product_id ?? "").trim();
        const variantId = String(offer.supplier_variant_id ?? "").trim();
        return /^\d{10,22}$/.test(parentId) &&
          /^\d{10,25}$/.test(variantId) &&
          !shopifyVariantIds.has(String(offer.variant_id));
      });
      // Persisted exclusions record the last real attempt even when CJ returns
      // no freight quote. Rotate by that timestamp so the oldest blocked offers
      // do not monopolize every 10-minute import batch.
      const retryIdentities = [...new Set(eligibleErroredOffers.map((offer) =>
        String(offer.supplier_product_id).trim() + ":" + String(offer.supplier_variant_id).trim(),
      ))];
      const { data: exclusionRows, error: exclusionReadError } = retryIdentities.length
        ? await db.from("commerce_events").select("entity_id,detail")
          .eq("event_type", "cj_import_exclusion").in("entity_id", retryIdentities).limit(5000)
        : { data: [], error: null };
      if (exclusionReadError) throw new Error("missing_shopify_retry_history_read_failed:" + exclusionReadError.message);
      const lastAttemptByIdentity = new Map<string, number>();
      for (const row of exclusionRows ?? []) {
        const identity = String(row.entity_id ?? "");
        const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
          ? row.detail as Record<string, unknown> : {};
        const timestamp = typeof detail.recordedAt === "string" ? Date.parse(detail.recordedAt) : Number.NaN;
        if (!Number.isFinite(timestamp)) continue;
        if (timestamp > (lastAttemptByIdentity.get(identity) ?? 0)) lastAttemptByIdentity.set(identity, timestamp);
      }
      const missingShopifyByParent = new Map<string, { variantIds: string[]; lastAttemptedAt: number }>();
      const orderedErroredOffers = [...eligibleErroredOffers].sort((a, b) => {
        const aIdentity = String(a.supplier_product_id).trim() + ":" + String(a.supplier_variant_id).trim();
        const bIdentity = String(b.supplier_product_id).trim() + ":" + String(b.supplier_variant_id).trim();
        return (lastAttemptByIdentity.get(aIdentity) ?? 0) - (lastAttemptByIdentity.get(bIdentity) ?? 0);
      });
      for (const offer of orderedErroredOffers) {
        const parentId = String(offer.supplier_product_id).trim();
        const variantId = String(offer.supplier_variant_id).trim();
        const identity = parentId + ":" + variantId;
        const group = missingShopifyByParent.get(parentId) ?? { variantIds: [], lastAttemptedAt: Number.POSITIVE_INFINITY };
        if (!group.variantIds.includes(variantId)) group.variantIds.push(variantId);
        group.lastAttemptedAt = Math.min(group.lastAttemptedAt, lastAttemptByIdentity.get(identity) ?? 0);
        missingShopifyByParent.set(parentId, group);
      }
      const retryCandidates: ImportCandidate[] = [...missingShopifyByParent.entries()]
        .sort((a, b) => a[1].lastAttemptedAt - b[1].lastAttemptedAt)
        .slice(0, limit)
        .map(([id, group]) => ({ id, title: "", retryVariantIds: group.variantIds }));
      const retryVariantLimit = Math.min(3, Math.max(1, limit));
      const evidenceRetryByParent = new Map<string, string[]>();
      let evidenceRetryCount = 0;
      const evidenceCutoff = Date.now() - 24 * 60 * 60_000;
      const staleVerifiedForEvidence = (staleVerifiedOffers ?? []).filter((offer) => {
        const checkedAt = typeof offer.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
        return !Number.isFinite(checkedAt) || checkedAt <= evidenceCutoff;
      });
      const existingOffersNeedingEvidence = [...(erroredOffers ?? []), ...staleVerifiedForEvidence].sort((a, b) =>
        String(a.last_checked_at ?? a.updated_at ?? "").localeCompare(String(b.last_checked_at ?? b.updated_at ?? "")),
      );
      for (const offer of existingOffersNeedingEvidence) {
        if (!shopifyVariantIds.has(String(offer.variant_id))) continue;
        const parentId = String(offer.supplier_product_id ?? "").trim();
        const variantId = String(offer.supplier_variant_id ?? "").trim();
        if (!/^\d{10,22}$/.test(parentId) || !/^\d{10,25}$/.test(variantId)) continue;
        const rawData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
          ? offer.raw_data as Record<string, unknown>
          : {};
        const nextReverifyAt = Date.parse(String(rawData.nextReverifyAt ?? ""));
        if (Number.isFinite(nextReverifyAt) && nextReverifyAt > Date.now()) continue;
        if (evidenceRetryCount >= retryVariantLimit) break;
        const variantIds = evidenceRetryByParent.get(parentId) ?? [];
        if (!variantIds.includes(variantId)) {
          variantIds.push(variantId);
          evidenceRetryCount += 1;
          retryOfferByVariantId.set(variantId, offer);
        }
        evidenceRetryByParent.set(parentId, variantIds);
      }
      const evidenceRetryCandidates: ImportCandidate[] = [...evidenceRetryByParent.entries()]
        .slice(0, limit)
        .map(([id, variantIds]) => ({ id, title: "", retryVariantIds: variantIds }));

      // Prefer never-imported CJ parents for remaining slots so search pages
      // containing existing products cannot consume the entire discovery batch.
      const newCandidates = [...uniqueSearchProducts.values()].filter((item) => !knownParentIds.has(item.id));
      let scanPage = page + 1;
      while (newCandidates.length < Math.max(0, limit - retryCandidates.length - evidenceRetryCandidates.length) && scanPage <= page + 2) {
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
      // Broad discovery still only imports new parents. Existing-parent retries are
      // limited to exact errored variants with no Shopify publication record.
      const evidenceParentIds = new Set(evidenceRetryCandidates.map((candidate) => candidate.id));
      const missingPublicationRetries = retryCandidates.filter((candidate) => !evidenceParentIds.has(candidate.id))
        .slice(0, Math.max(0, limit - evidenceRetryCandidates.length));
      const discoverySlots = Math.max(0, limit - evidenceRetryCandidates.length - missingPublicationRetries.length);
      candidates = [...evidenceRetryCandidates, ...missingPublicationRetries, ...newCandidates.slice(0, discoverySlots)];
    }
    for (const candidate of candidates) {
      try {
        const detail = forcedDetails.get(candidate.id) ?? await getCJProductDetail(candidate.id);
        if (!detail) { recordSkip("product_detail_missing"); continue; }
        const variants = await fetchCJProductVariants(candidate.id);
        if (!variants.length) { recordSkip("variants_missing"); continue; }
        stats.products++;
        stats.variantsAvailable += variants.length;
        // Retry only the exact errored child IDs that lack a Shopify publication row;
        // normal discovery keeps its rotating bounded child-variant batch.
        const variantBatch = candidate.retryVariantIds?.length
          ? variants.filter((item) => candidate.retryVariantIds!.includes(String(item.vid)))
          : selectRotatingVariantBatch(variants, variantBatchLimit, variantRunSlot);
        if (candidate.retryVariantIds?.length && variantBatch.length !== candidate.retryVariantIds.length) {
          stats.errors.push("retry_variant_not_in_parent_catalog:" + candidate.id);
        }
        for (const variant of variantBatch) {
          try {
            if (!variant.vid) { recordSkip("variant_id_missing"); continue; }
            // Always resolve the exact live VID. A non-empty productId in a
            // product-scoped response may be stale or point at a backup parent.
            const exactVariant = await fetchCJVariantByVid(variant.vid);
            if (!exactVariant || exactVariant.vid !== variant.vid || !String(exactVariant.productId ?? "").trim()) {
              recordSkip("canonical_supplier_product_id_unresolved");
              const reason = "canonical_supplier_product_id_unresolved";
              stats.errors.push(reason + ":" + candidate.id + ":" + variant.vid);
              const logError = await recordCjExclusion(candidate.id + ":" + variant.vid, reason, { catalogProductId: candidate.id, variantId: variant.vid });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const supplierProductId = String(exactVariant.productId).trim();
            const cost = Number(exactVariant.sellPrice);
            if (!Number.isFinite(cost) || cost <= 0) {
              recordSkip("canonical_supplier_variant_price_unresolved");
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
            // A variant may be stocked in a verified warehouse other than CN. Try
            // Try several stocked origin warehouses, then CN as a fallback.
            // A null quote is not a zero-cost quote; retain diagnostics for every attempted origin.
            const stockedOrigins = [...new Set((exactVariant.inventoryByCountry ?? [])
              .filter((warehouse) => /^[A-Z]{2}$/.test(warehouse.countryCode) && warehouse.quantity >= 1)
              .sort((a, b) => b.quantity - a.quantity)
              .map((warehouse) => warehouse.countryCode))];
            const freightOrigins = [...stockedOrigins.slice(0, 3), "CN"]
              .filter((countryCode, index, values) => values.indexOf(countryCode) === index);
            const freightZip = process.env.TRACER_CJ_FREIGHT_QUOTE_ZIP?.trim() || undefined;
            let shipping: number | null = null;
            const freightErrors: string[] = [];
            const freightAttempts: Array<{ origin: string; result: "quoted" | "no_quote" | "error"; diagnostics?: string[] }> = [];
            for (const startCountryCode of freightOrigins) {
              const diagnostics: string[] = [];
              try {
                const quote = await calculateCJFreight(variant.vid, {
                  productId: exactVariant.productId,
                  startCountryCode,
                  endCountryCode: "JP",
                  quantity: 1,
                  ...(freightZip ? { zip: freightZip } : {}),
                  diagnostics,
                });
                if (quote !== null && Number.isFinite(quote) && quote >= 0) {
                  shipping = quote;
                  freightAttempts.push({ origin: startCountryCode, result: "quoted", diagnostics: diagnostics.slice(0, 8) });
                  break;
                }
                freightAttempts.push({ origin: startCountryCode, result: "no_quote", diagnostics: diagnostics.slice(0, 8) });
              } catch (reason) {
                freightAttempts.push({ origin: startCountryCode, result: "error", diagnostics: diagnostics.slice(0, 8) });
                freightErrors.push(startCountryCode + ":" + String(reason).slice(0, 100));
              }
            }
            const stock = stockResult.status === "fulfilled" ? stockResult.value : null;
            if (stockResult.status === "rejected") stats.errors.push("stock:" + candidate.id + ":" + String(stockResult.reason).slice(0, 100));
            if (shipping === null && freightErrors.length > 0) stats.errors.push("freight:" + candidate.id + ":" + freightErrors.join("|").slice(0, 180));
            // A failed/unknown live lookup is not evidence that a previously verified offer is invalid.
            // Preserve its last known evidence; the freshness gate will stop publication once it expires.
            // Do not overwrite it with inventory=0, shipping=0, or sourceStatus=error on transient API failures.
            const shippingWasEstimated = shipping === null;
            const shippingCostForPricing = shipping ?? 7.76;
            if (stock === null) {
              recordSkip("supplier_stock_unconfirmed");
              const reason = "supplier_stock_unconfirmed";
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, reason, {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
                stockKnown: stock !== null,
                shippingKnown: shipping !== null,
                shippingEstimated: shippingWasEstimated,
                shippingEstimateUsd: shippingWasEstimated ? 7.76 : null,
                shippingEstimateSource: shippingWasEstimated ? "cj_historical_p90_570_offers" : null,
                freightAttempts,
                freightZipConfigured: Boolean(freightZip),
                freightErrors: freightErrors.slice(0, 4),
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              const retryOffer = retryOfferByVariantId.get(String(exactVariant.vid));
              if (retryOffer?.id) {
                const retryRawData = retryOffer.raw_data && typeof retryOffer.raw_data === "object" && !Array.isArray(retryOffer.raw_data)
                  ? retryOffer.raw_data as Record<string, unknown>
                  : {};
                const attempts = Math.max(0, Number(retryRawData.reverifyAttempts) || 0) + 1;
                const now = Date.now();
                const nowIso = new Date(now).toISOString();
                const delayMs = Math.min(6 * 60 * 60_000, 30 * 60_000 * (2 ** Math.min(attempts - 1, 4)));
                const { error: retryBackoffError } = await db.from("supplier_offers").update({
                  raw_data: {
                    ...retryRawData,
                    ...(stock !== null ? { observedInventory: Math.max(0, Math.floor(stock)) } : {}),
                    reverifyAttempts: attempts,
                    lastReverifyAt: nowIso,
                    nextReverifyAt: new Date(now + delayMs).toISOString(),
                    lastReverifyReason: reason,
                  },
                  updated_at: nowIso,
                }).eq("id", retryOffer.id);
                if (retryBackoffError) stats.errors.push("reverify_backoff_persist:" + retryBackoffError.message.slice(0, 80));
              }
              continue;
            }
            const complianceBlockReason = japaneseCommerceComplianceBlockReason(canonicalDetail.title, canonicalDetail.productType);
            const title = japaneseCommerceTitle(canonicalDetail.title, canonicalDetail.productType, supplierProductId === candidate.id ? variants.flatMap((item) => typeof item.nameEn === "string" && item.nameEn.trim().length > 0 ? [item.nameEn] : []) : []) || (supplierProductId === candidate.id ? japaneseCommerceTitle(candidate.title, candidate.productType) : null);
            if (!title) {
              recordSkip("japanese_title_unavailable");
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
                currency: "USD", unitCost: cost, shippingCost: shippingCostForPricing,
                inventory: complianceBlockReason || stock === null ? 0 : Math.max(0, Math.floor(stock)), shipTo: "JP",
                trackingSupported: !complianceBlockReason,
                sourceStatus: !complianceBlockReason && stock !== null ? "verified" : "error",
                lastCheckedAt: new Date().toISOString(),
                rawData: {
                  query, page, catalogProductId: candidate.id, productId: supplierProductId, variantId: exactVariant.vid,
                  stockKnown: stock !== null, shippingKnown: shipping !== null,
                  shippingEstimated: shippingWasEstimated,
                  shippingEstimateUsd: shippingWasEstimated ? 7.76 : null,
                  shippingEstimateSource: shippingWasEstimated ? "cj_historical_p90_570_offers" : null,
                  freightAttempts,
                  ...(stock !== null ? { observedInventory: Math.max(0, Math.floor(stock)) } : {}),
                  fxRate: fx.rate, complianceBlockReason,
                  ...(complianceBlockReason ? {
                    lastReverifyAt: new Date().toISOString(),
                    nextReverifyAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
                    lastReverifyReason: complianceBlockReason,
                  } : {}),
                },
              },
            });
            stats.variants++;
            stats.offers++;
            if (complianceBlockReason) {
              stats.complianceBlocked++;
              recordSkip("compliance_blocked:" + complianceBlockReason);
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, complianceBlockReason, {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            // Price the mapped offer even at zero stock; listing availability and live procurement are separate.
            // The paid-order procurement path independently rechecks inventory before supplier submission.
            if (shipping !== null && shipping >= 0) {
              await recalculatePrice({ variantId: saved.variantId, offerId: saved.offerId, exchangeRateToJpy: fx.rate, feeRate: 0.1, targetMarginRate: 0.5 });
              stats.priced++;
            } else {
              recordSkip("shipping_not_priced");
            }
          } catch (error) {
            stats.errors.push("variant:" + candidate.id + ":" + variant.vid + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
          }
        }
      } catch (error) {
        stats.errors.push("product:" + candidate.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
      }
    }
    console.info("[TRACER COMMERCE CJ IMPORT REPORT]", {
      ok: stats.errors.length === 0,
      query,
      page,
      fxRate: fx.rate,
      stats,
    });
    return NextResponse.json({ ok: stats.errors.length === 0, query, page, fxRate: fx.rate, fxSource: fx.source, stats }, { status: stats.errors.length ? 207 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER COMMERCE CJ IMPORT FAILED]", { query, page, stats, error: message.slice(0, 300) });
    return NextResponse.json({ ok: false, query, page, stats, error: message }, { status: 502 });
  }
}
