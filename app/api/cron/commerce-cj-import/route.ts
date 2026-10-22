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
import { persistCjInternalSupplyCandidate } from "@/lib/suppliers/persist-cj-internal-supply";

export const runtime = "nodejs";
export const maxDuration = 300;

function japaneseCommerceComplianceBlockReason(title: string, productType?: string | null): string | null {
  const source = (String(title ?? "") + " " + String(productType ?? "")).toLowerCase();
  if (/high temperature disinfection cabinet|disinfection cabinet/.test(source)) {
    return "japan_compliance_unverified_disinfection_cabinet";
  }
  return null;
}

function sourceSpecificFallbackTitle(title: string, variantNames: string[] = []): string | null {
  const source = String(title ?? "").normalize("NFKC").toLowerCase();
  const variants = variantNames.join(" ").toLowerCase();
  const all = source + " " + variants;
  const words: Array<[RegExp, string]> = [
    [/rose|floral|flower/, "花柄"],
    [/knit|knitted|crochet/, "ニット編み"],
    [/woven|weaving|braided/, "編み込み"],
    [/retro|vintage/, "レトロデザイン"],
    [/rhinestone|diamond|crystal|bling/, "ビジュー装飾"],
    [/pearl/, "パール装飾"],
    [/tassel|fringe/, "タッセル付き"],
    [/bow|ribbon/, "リボンモチーフ"],
    [/snake.print|leopard|alligator|crocodile|animal print/, "アニマル柄"],
    [/transparent|clear/, "クリア素材"],
    [/plush|fluffy|fleece/, "ふんわり素材"],
    [/canvas/, "キャンバス素材"],
    [/denim/, "デニム素材"],
    [/suede/, "スエード調"],
    [/leather|cowhide|sheepskin|pu /, "レザー調"],
    [/metal|metallic|chain|buckle/, "メタルパーツ付き"],
    [/crescent|moon/, "三日月型"],
    [/star|stars/, "星モチーフ"],
    [/cat/, "猫モチーフ"],
    [/butterfly|moth/, "蝶モチーフ"],
    [/geometric|rhombus|diamond pattern/, "幾何学柄"],
    [/color.block|contrast.color|two.color/, "配色切替"],
    [/large.capacity|capacity/, "大容量"],
    [/mini|small/, "ミニサイズ"],
    [/laptop|computer/, "PC収納対応"],
    [/commuter|work bag/, "通勤向け"],
    [/crossbody|cross.shoulder|messenger/, "斜めがけ"],
    [/underarm|armpit/, "アンダーアーム"],
    [/clutch|evening/, "パーティー向け"],
    [/hair claw|shark clip|claw clip/, "シャーク型"],
    [/christmas|santa|elk|snowflake/, "クリスマスモチーフ"],
    [/halloween|ghost|pumpkin/, "ハロウィンモチーフ"],
    [/plaid|checkered|checkerboard/, "チェック柄"],
    [/scissors|salon|duckbill/, "サロン用"],
    [/12\s*pcs|12pcs|dozen/, "12本セット"],
    [/15\s*pcs|15pcs/, "15本セット"],
    [/150 piece|150-piece|150 pcs/, "150本セット"],
    [/electric|automatic|machine|cleaner/, "電動クリーナー"],
    [/cleaning|cleaner|wash/, "お手入れ用品"],
    [/eyebrow|brow/, "眉メイク用"],
    [/eyelash|lash/, "まつげ用"],
    [/gua sha|scraping|roller massager|massage/, "フェイスケア用"],
    [/acne|pimple|comedone/, "毛穴ケア用"],
    [/nail|manicure/, "ネイルケア用"],
    [/wooden handle|wood handle/, "木製ハンドル"],
    [/diamond handle/, "ビジューハンドル"],
    [/silicone/, "シリコン製"],
    [/stainless steel|steel/, "スチール製"],
    [/portable|retractable|travel/, "携帯用"],
    [/10 pcs|10pcs/, "10本セット"],
    [/8 mini|8 mini brushes|8 brushes/, "8本セット"],
    [/9 beige|beige brushes/, "ベージュカラー"],
    [/80ml/, "80mL"],
  ];
  const modifiers = [...new Set(words.filter(([pattern]) => pattern.test(all)).map(([, label]) => label))];
  let core: string | null = null;
  if (/handbag|purse/.test(source)) core = "レディースハンドバッグ";
  else if (/crossbody|messenger/.test(source)) core = "レディースクロスボディバッグ";
  else if (/shoulder bag|shoulder handbag|one shoulder/.test(source)) core = "レディースショルダーバッグ";
  else if (/tote/.test(source)) core = "レディーストートバッグ";
  else if (/bag/.test(source)) core = "レディースバッグ";
  else if (/hair clip|hair claw|barrette|hairpin|hair pin/.test(source)) core = "ヘアアクセサリー";
  else if (/headband|hair band|hair tie|scrunchie|hair rope/.test(source)) core = "ヘアバンド・ヘアゴム";
  else if (/makeup brush|cosmetic brush|brush cleaner|brush cleaning|brush scrubber|puff cleanser/.test(source)) core = "メイクブラシ・お手入れ用品";
  else if (/eyebrow|eyelash|lash|gua sha|roller massager|acne|pimple|nail|beauty tool|facial/.test(source)) core = "美容ケアツール";
  if (!core) return null;
  const meaningful = modifiers.filter((item) => !["レザー調"].includes(item));
  if (meaningful.length === 0 && variants) {
    const color = [/black/.test(variants) && "ブラック", /white/.test(variants) && "ホワイト", /pink/.test(variants) && "ピンク", /brown|coffee/.test(variants) && "ブラウン", /blue/.test(variants) && "ブルー", /green/.test(variants) && "グリーン", /purple/.test(variants) && "パープル", /gold/.test(variants) && "ゴールド", /silver/.test(variants) && "シルバー"].filter(Boolean);
    if (color.length) meaningful.push(...color);
  }
  if (meaningful.length === 0) return null;
  return (meaningful.slice(0, 2).join("・") + " " + core).slice(0, 120);
}

function japaneseCommerceTitle(title: string, productType?: string | null, variantNames: string[] = []): string | null {
  const source = (String(title ?? "") + " " + String(productType ?? "")).toLowerCase();

  // Prefer source-specific localization before broad importer fallbacks. This
  // prevents detailed CJ titles from collapsing to generic labels such as
  // "ヘアケアアイテム" or "ヘアバンド".
  const localizedFirst = localizeProductTitle(title, productType);
  const genericLocalizedTitles = new Set([
    "ヘアケアアイテム", "ヘアバンド", "ヘアアクセサリー", "ヘアクリップ",
    "レディース ヘアアクセサリー", "美容・メイクアイテム",
    "美容ツール", "バッグ・収納アイテム", "レディースハンドバッグ",
    "レディース ハンドバッグ", "レディース ショルダーバッグ",
    "レディース クロスボディバッグ", "レディース トートバッグ",
    "ハンドバッグ", "ショルダーバッグ", "メイクブラシ",
  ]);
  if (localizedFirst && !genericLocalizedTitles.has(localizedFirst)) {
    return localizedFirst;
  }

  const normalizedTitle = String(title ?? "").trim().toLowerCase();
  if (/^women handbag$/.test(normalizedTitle) && variantNames.length === 1) {
    const variant = String(variantNames[0] ?? "").toLowerCase();
    if (/gold/.test(variant)) return "ゴールドカラーのレディースハンドバッグ";
    if (/silver/.test(variant)) return "シルバーカラーのレディースハンドバッグ";
  }
  const rules: Array<[RegExp, string]> = [
    [/synthetic hair extension clips 16 clips hair cover-up pieces 4 colors|hair cover-up pieces.*4 colors/, "ヘアエクステ用クリップ16個セット（4色）"],
    [/net celebrity curling artifact lazy sponge curling iron|sponge curling iron.*curling iron/, "スポンジカーラー"],
    [/springsummer vibe adjustable lace scrunchie|adjustable lace scrunchie/, "レースデザインの調節式シュシュ"],
    [/air cushion comb cleaner brush cleaning brush|comb cleaner brush/, "クッションコーム用クリーナーブラシ"],
    [/6 pack headbands for women.*boho wide head bands hair accessories|boho wide head bands hair accessories.*6 pack headbands/, "レディース用ボヘミアン風ワイドヘッドバンド6本セット"],
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
    "レディース ハンドバッグ",
    "レディース ショルダーバッグ",
    "レディース クロスボディバッグ",
    "レディース トートバッグ",
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
    "ヘアケアアイテム",
    "バッグ・収納アイテム",
    "スマートフォンケース",
    "ペット用品",
    "キッチン収納用品",
    "旅行用収納ポーチ",
    "アクセサリー",
  ]);
  if (categoryOnlyTitles.has(specific[1])) {
    const sourceSpecificTitle = localizeProductTitle(title, productType);
    if (sourceSpecificTitle && !categoryOnlyTitles.has(sourceSpecificTitle) && !genericLocalizedTitles.has(sourceSpecificTitle)) {
      return sourceSpecificTitle;
    }
    return sourceSpecificFallbackTitle(title, variantNames);
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
  // Rotate focused CJ searches across the catalog priorities instead of
  // repeatedly sampling broad queries whose first pages are already known.
  const queryOptions = [
    "women handbag", "crossbody bag women", "tote bag women", "shoulder bag women", "mini bag women",
    "beauty tools", "makeup brush cleaner", "makeup organizer",
    "hair accessories women", "claw clips hair", "satin hair scrunchies", "heatless curling rod",
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
  const variantBatchLimit = Math.min(6, Math.max(1, Number(url.searchParams.get("variantLimit") || 6)));
  const variantRunSlot = Math.floor(Date.now() / 600_000);
  const fx = await getObservedUsdToJpyRate();
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    console.error("[TRACER COMMERCE CJ IMPORT FAILED]", { reason: "usd_jpy_rate_unavailable", imported: 0 });
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", imported: 0 }, { status: 503 });
  }

  const stats = { searched: 0, products: 0, variantsAvailable: 0, variants: 0, offers: 0, priced: 0, supplierListingEvidenceUpdated: 0, supplierListingEvidenceCreated: 0, supplierListingEvidenceUnmatched: 0, complianceBlocked: 0, skipped: 0, verifiedOffersStaleEligible: 0, publicationBlockedVariantsSeen: 0, evidenceRetryVariantsQueued: 0, evidenceRetryDeferredByBackoff: 0, staleLegacyListingVariantsQueued: 0, finalEvidenceParentCount: 0, missingPublicationRetriesQueued: 0, newDiscoveryCandidatesQueued: 0, discoverySearchPagesScanned: 0, finalCandidateCount: 0, skipReasons: {} as Record<string, number>, errors: [] as string[] };
  const recordSkip = (reason: string) => { stats.skipped++; stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1; };
  try {
    type ImportCandidate = { id: string; title: string; productType?: string | null; imageUrl?: string | null; retryVariantIds?: string[] };
    const requestedProductIds = url.searchParams.has("productIds")
      ? [...new Set((url.searchParams.get("productIds") ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d{10,22}$/.test(id)))].slice(0, limit)
      : [];
    const requestedVariantIds = url.searchParams.has("variantIds")
      ? [...new Set((url.searchParams.get("variantIds") ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d{10,25}$/.test(id)))].slice(0, 3)
      : [];
    if (url.searchParams.has("productIds") && requestedProductIds.length === 0) {
      return NextResponse.json({ ok: false, error: "invalid_product_ids", imported: 0 }, { status: 400 });
    }
    if (url.searchParams.has("variantIds") && (requestedVariantIds.length === 0 ||
        (url.searchParams.get("variantIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean).length > 3 ||
        (url.searchParams.get("variantIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean).some((id) => !/^\d{10,25}$/.test(id)) ||
        (url.searchParams.has("productIds") && requestedProductIds.length === 0))) {
      return NextResponse.json({ ok: false, error: "invalid_variant_ids", maxVariantIds: 3, imported: 0 }, { status: 400 });
    }
    const forcedDetails = new Map<string, Awaited<ReturnType<typeof getCJProductDetail>>>();
    let candidates: ImportCandidate[] = [];
    const retryOfferByVariantId = new Map<string, { id: string; raw_data: unknown }>();
    if (requestedProductIds.length > 0 || requestedVariantIds.length > 0) {
      const requestedByParent = new Map<string, string[]>();
      if (requestedVariantIds.length > 0) {
        const { data: requestedOffers, error: requestedOffersError } = await db
          .from("supplier_offers")
          .select("supplier_product_id,supplier_variant_id")
          .eq("supplier_code", "cj")
          .in("supplier_variant_id", requestedVariantIds);
        if (requestedOffersError) throw new Error("requested_variant_lookup_failed:" + requestedOffersError.message);
        for (const variantId of requestedVariantIds) {
          const parents = [...new Set((requestedOffers ?? [])
            .filter((offer) => String(offer.supplier_variant_id) === variantId)
            .map((offer) => String(offer.supplier_product_id ?? "").trim())
            .filter((id) => /^\d{10,22}$/.test(id)))];
          if (parents.length !== 1) {
            return NextResponse.json({
              ok: false,
              error: parents.length === 0 ? "requested_variant_not_found" : "requested_variant_parent_ambiguous",
              variantId,
              imported: 0,
            }, { status: parents.length === 0 ? 404 : 409 });
          }
          const group = requestedByParent.get(parents[0]) ?? [];
          group.push(variantId);
          requestedByParent.set(parents[0], group);
        }
      }
      const requestedIds = [...new Set([...requestedProductIds, ...requestedByParent.keys()])];
      for (const id of requestedIds) {
        const detail = await getCJProductDetail(id);
        if (!detail) {
          stats.skipped++;
          stats.errors.push("requested_product_detail_missing:" + id);
          continue;
        }
        forcedDetails.set(id, detail);
        const retryVariantIds = requestedByParent.get(id);
        candidates.push({
          id,
          title: detail.title,
          productType: detail.productType,
          imageUrl: detail.imageUrl,
          ...(retryVariantIds?.length ? { retryVariantIds } : {}),
        });
      }
      stats.searched = candidates.length;
    } else {
      let results: Awaited<ReturnType<typeof searchCJProducts>>;
      try {
        results = await searchCJProducts(query, { page, size: Math.min(20, limit * 2) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A transient timeout on the rotating discovery query must not discard
        // recovery work for known supplier variants. Leave discovery for the next
        // cron slot, but continue with persisted retry queues.
        if (!/abort|timeout|timed out|fetch failed|network/i.test(message)) throw error;
        stats.errors.push("cj_search_retryable_timeout:" + page + ":" + message.slice(0, 120));
        console.warn("[TRACER CJ DISCOVERY DEFERRED]", { query, page, reason: message.slice(0, 160) });
        results = { query, totalRecords: 0, totalPages: 0, products: [] };
      }
      stats.searched = results.products.length;
      const { data: knownProducts, error: knownProductsError } = await db
        .from("commerce_products").select("source_key").like("source_key", "cj:%").limit(5000);
      if (knownProductsError) throw new Error("known_cj_catalog_read_failed:" + knownProductsError.message);
      const knownParentIds = new Set((knownProducts ?? []).map((row) => {
        const key = String(row.source_key ?? "");
        return key.startsWith("cj:") ? key.slice(3) : "";
      }).filter(Boolean));
      stats.discoverySearchPagesScanned = 1;
      const uniqueSearchProducts = new Map<string, ImportCandidate>();
      for (const item of results.products) {
        const id = String(item.id ?? "").trim();
        if (/^\d{10,22}$/.test(id) && !uniqueSearchProducts.has(id)) uniqueSearchProducts.set(id, item);
      }
      // Keep missing-publication recovery narrow and separately recheck existing listings
      // whose saved supplier status, stock, or Japan-bound freight evidence is in error.
      const [{ data: erroredOffers, error: erroredOffersError }, { data: staleVerifiedOffers, error: staleVerifiedOffersError }, { data: shopifyRows, error: shopifyRowsError }, { data: publicationErrorRows, error: publicationErrorRowsError }, { data: cjListingRows, error: cjListingRowsError }, { data: publishedShopRows, error: publishedShopRowsError }] = await Promise.all([
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
        // Prioritize recovery for variants blocked from either storefront.
        db.from("channel_listings").select("variant_id,channel,last_error")
          .or("last_error.like.supplier_offer_not_fulfillable%,last_error.like.supplier_offer_no_longer_fulfillable%,last_error.eq.japanese_product_title_invalid").limit(5000),
        // Procurement freshness gates read supplier_listings, not only commerce offers.
        // Refresh stale/missing timestamps from the exact native CJ IDs so verified
        // legacy listings don't remain permanently unorderable.
        db.from("supplier_listings")
          .select("id,supplier_product_id,supplier_variant_id,shipping_checked_at,inventory_checked_at,next_verification_at")
          .eq("supplier", "cj")
          .order("updated_at", { ascending: true }).limit(2000),
        // Published legacy commerce listings need live evidence refresh before their next sale.
        db.from("shop_listings").select("supplier_product_id,supplier_variant_id")
          .eq("published", true).ilike("supplier_name", "cj").limit(1000),
      ]);
      if (erroredOffersError || staleVerifiedOffersError || shopifyRowsError || publicationErrorRowsError || cjListingRowsError || publishedShopRowsError) {
        throw new Error("missing_shopify_offer_recovery_read_failed:" + (erroredOffersError?.message ?? staleVerifiedOffersError?.message ?? shopifyRowsError?.message ?? publicationErrorRowsError?.message ?? cjListingRowsError?.message ?? publishedShopRowsError?.message));
      }
      const shopifyVariantIds = new Set((shopifyRows ?? []).map((row) => String(row.variant_id)));
      const publicationErrorVariantIds = new Set((publicationErrorRows ?? []).map((row) => String(row.variant_id)));
      const publishedShopSupplierIdentities = new Set((publishedShopRows ?? []).map((row) =>
        String(row.supplier_product_id ?? "").trim() + ":" + String(row.supplier_variant_id ?? "").trim(),
      ).filter((identity) => identity !== ":"));
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
      // Increase stale/blocked evidence recovery while keeping each run bounded.
      const retryVariantLimit = Math.min(8, Math.max(4, limit * 2));
      const evidenceRetryByParent = new Map<string, string[]>();
      let evidenceRetryCount = 0;
      const evidenceCutoff = Date.now() - 24 * 60 * 60_000;
      const staleVerifiedForEvidence = (staleVerifiedOffers ?? []).filter((offer) => {
        const checkedAt = typeof offer.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
        // A publication failure is itself a retry signal. Do not let a recent
        // last_checked_at suppress live supplier revalidation for a blocked listing.
        // A publication error triggers the publisher's retry queue, but must not
        // bypass evidence freshness forever. Otherwise the same recently refreshed
        // variants are rechecked every cron run and starve the remaining stale queue.
        // The publish cron retries retryable supplier_offer_not_fulfillable rows.
        return !Number.isFinite(checkedAt) || checkedAt <= evidenceCutoff;
      });
      stats.verifiedOffersStaleEligible = staleVerifiedForEvidence.length;
      stats.publicationBlockedVariantsSeen = publicationErrorVariantIds.size;
      const existingOffersNeedingEvidence = [...(erroredOffers ?? []), ...staleVerifiedForEvidence].sort((a, b) => {
        const aIdentity = String(a.supplier_product_id ?? "").trim() + ":" + String(a.supplier_variant_id ?? "").trim();
        const bIdentity = String(b.supplier_product_id ?? "").trim() + ":" + String(b.supplier_variant_id ?? "").trim();
        const aBlocked = publishedShopSupplierIdentities.has(aIdentity) ? 0 : publicationErrorVariantIds.has(String(a.variant_id)) ? 1 : 2;
        const bBlocked = publishedShopSupplierIdentities.has(bIdentity) ? 0 : publicationErrorVariantIds.has(String(b.variant_id)) ? 1 : 2;
        return aBlocked - bBlocked ||
          String(a.last_checked_at ?? a.updated_at ?? "").localeCompare(String(b.last_checked_at ?? b.updated_at ?? ""));
      });
      for (const offer of existingOffersNeedingEvidence) {
        // Refresh every stale verified offer, including variants without a storefront listing.
        // Otherwise these offers can never regain fresh stock/freight evidence.

        const parentId = String(offer.supplier_product_id ?? "").trim();
        const variantId = String(offer.supplier_variant_id ?? "").trim();
        if (!/^\d{10,22}$/.test(parentId) || !/^\d{10,25}$/.test(variantId)) continue;
        const rawData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
          ? offer.raw_data as Record<string, unknown>
          : {};
        const nextReverifyAt = Date.parse(String(rawData.nextReverifyAt ?? ""));
        // A storefront listing already blocked by stale supplier evidence must be retried
        // ahead of normal backoff. Otherwise a previously published product can stay
        // unpurchasable indefinitely even while the importer runs successfully.
        const publishedShopListing = publishedShopSupplierIdentities.has(parentId + ":" + variantId);
        if (!publicationErrorVariantIds.has(String(offer.variant_id)) && !publishedShopListing && Number.isFinite(nextReverifyAt) && nextReverifyAt > Date.now()) {
          stats.evidenceRetryDeferredByBackoff++;
          continue;
        }
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
      stats.evidenceRetryVariantsQueued = evidenceRetryCount;

      // Build a separate exact-ID queue for supplier_listings whose procurement
      // evidence is missing or stale. Do not infer supplier IDs from titles/SKUs.
      const staleListingGroups = new Map<string, { variantIds: string[]; oldestAt: number }>();
      for (const listing of cjListingRows ?? []) {
        const parentId = String(listing.supplier_product_id ?? "").trim();
        const variantId = String(listing.supplier_variant_id ?? "").trim();
        if (!/^\d{10,22}$/.test(parentId) || !/^\d{10,25}$/.test(variantId)) continue;
        const shippingAt = typeof listing.shipping_checked_at === "string" ? Date.parse(listing.shipping_checked_at) : Number.NaN;
        const inventoryAt = typeof listing.inventory_checked_at === "string" ? Date.parse(listing.inventory_checked_at) : Number.NaN;
        const nextAt = typeof listing.next_verification_at === "string" ? Date.parse(listing.next_verification_at) : Number.NaN;
        const shippingEvidenceMissing = !Number.isFinite(shippingAt);
        const inventoryEvidenceMissing = !Number.isFinite(inventoryAt);
        const evidenceMissing = shippingEvidenceMissing || inventoryEvidenceMissing;
        const evidenceStale = evidenceMissing || shippingAt <= evidenceCutoff || inventoryAt <= evidenceCutoff;
        // A future backoff must not hide missing evidence: without both timestamps,
        // a row has never completed the required live stock + Japan-freight check.
        if (!evidenceStale || (!evidenceMissing && Number.isFinite(nextAt) && nextAt > Date.now())) continue;
        const group = staleListingGroups.get(parentId) ?? { variantIds: [], oldestAt: Number.POSITIVE_INFINITY };
        if (!group.variantIds.includes(variantId)) group.variantIds.push(variantId);
        group.oldestAt = Math.min(group.oldestAt, Number.isFinite(shippingAt) ? shippingAt : 0, Number.isFinite(inventoryAt) ? inventoryAt : 0);
        staleListingGroups.set(parentId, group);
      }
      const staleListingRetryCandidates: ImportCandidate[] = [...staleListingGroups.entries()]
        .sort((a, b) => a[1].oldestAt - b[1].oldestAt)
        .slice(0, limit)
        .map(([id, group]) => ({ id, title: "", retryVariantIds: group.variantIds.slice(0, 4) }));
      stats.staleLegacyListingVariantsQueued = staleListingRetryCandidates.reduce((total, candidate) => total + (candidate.retryVariantIds?.length ?? 0), 0);

      // Prefer never-imported CJ parents for remaining slots so search pages
      // containing existing products cannot consume the entire discovery batch.
      const newCandidates = [...uniqueSearchProducts.values()].filter((item) => !knownParentIds.has(item.id));
      let scanPage = page + 1;
      // Keep a bounded discovery budget even when recovery queues are full.
      // Search up to five additional pages so dense pages of known products do
      // not starve new parents; record actual scan count for runtime diagnosis.
      while (newCandidates.length < 1 && scanPage <= page + 5) {
        let extra: Awaited<ReturnType<typeof searchCJProducts>>;
        try {
          extra = await searchCJProducts(query, { page: scanPage, size: Math.min(20, limit * 2) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/abort|timeout|timed out|fetch failed|network/i.test(message)) throw error;
          stats.errors.push("cj_discovery_scan_deferred:" + scanPage + ":" + message.slice(0, 120));
          console.warn("[TRACER CJ DISCOVERY SCAN DEFERRED]", { query, page: scanPage, reason: message.slice(0, 160) });
          break;
        }
        stats.discoverySearchPagesScanned += 1;
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
      const evidenceVariantsByParent = new Map<string, string[]>();
      for (const candidate of [...evidenceRetryCandidates, ...staleListingRetryCandidates]) {
        const variantIds = evidenceVariantsByParent.get(candidate.id) ?? [];
        for (const variantId of candidate.retryVariantIds ?? []) {
          if (!variantIds.includes(variantId)) variantIds.push(variantId);
        }
        evidenceVariantsByParent.set(candidate.id, variantIds);
      }
      // Reserve one slot for discovery on every normal run, even when early pages
      // contain no new parent. If discovery finds nothing, leave the slot unused
      // instead of allowing recovery retries to monopolize the entire batch.
      // Reserve a discovery slot only when discovery actually found a new parent.
      // If it found none, use all bounded candidate slots for supplier-evidence recovery.
      const reserveDiscoverySlot = newCandidates.length > 0 ? 1 : 0;
      const dedupedEvidenceCandidates: ImportCandidate[] = [...evidenceVariantsByParent.entries()]
        .slice(0, Math.max(0, limit - reserveDiscoverySlot))
        .map(([id, variantIds]) => ({ id, title: "", retryVariantIds: variantIds.slice(0, 4) }));
      const evidenceParentIds = new Set(dedupedEvidenceCandidates.map((candidate) => candidate.id));
      const missingPublicationRetries = retryCandidates.filter((candidate) => !evidenceParentIds.has(candidate.id))
        .slice(0, Math.max(0, limit - dedupedEvidenceCandidates.length - reserveDiscoverySlot));
      const discoverySlots = Math.max(0, limit - dedupedEvidenceCandidates.length - missingPublicationRetries.length);
      const queuedDiscoveryCandidates = newCandidates.slice(0, discoverySlots);
      stats.finalEvidenceParentCount = dedupedEvidenceCandidates.length;
      stats.missingPublicationRetriesQueued = missingPublicationRetries.length;
      stats.newDiscoveryCandidatesQueued = queuedDiscoveryCandidates.length;
      candidates = [...dedupedEvidenceCandidates, ...missingPublicationRetries, ...queuedDiscoveryCandidates];
      stats.finalCandidateCount = candidates.length;
    }
    // Enforce one global child-variant budget across discovery and all retry queues.
    // Rotate candidate order so a parent with several retry variants cannot starve other parents.
    let variantBudgetRemaining = variantBatchLimit;
    const candidateRotation = candidates.length > 0 ? variantRunSlot % candidates.length : 0;
    const orderedCandidates = [...candidates.slice(candidateRotation), ...candidates.slice(0, candidateRotation)];
    for (const candidate of orderedCandidates) {
      if (variantBudgetRemaining <= 0) break;
      try {
        const detail = forcedDetails.get(candidate.id) ?? await getCJProductDetail(candidate.id);
        if (!detail) { recordSkip("product_detail_missing"); continue; }
        const variants = await fetchCJProductVariants(candidate.id);
        if (!variants.length) { recordSkip("variants_missing"); continue; }
        stats.products++;
        stats.variantsAvailable += variants.length;
        // Retry only the exact errored child IDs that lack a Shopify publication row;
        // normal discovery keeps its rotating bounded child-variant batch.
        const retryVariants = candidate.retryVariantIds?.length
          ? variants.filter((item) => candidate.retryVariantIds!.includes(String(item.vid)))
          : null;
        if (candidate.retryVariantIds?.length && (retryVariants?.length ?? 0) !== candidate.retryVariantIds.length) {
          stats.errors.push("retry_variant_not_in_parent_catalog:" + candidate.id);
        }
        const variantBatch = retryVariants
          ? selectRotatingVariantBatch(retryVariants, Math.min(variantBatchLimit, variantBudgetRemaining), variantRunSlot)
          : selectRotatingVariantBatch(variants, Math.min(variantBatchLimit, variantBudgetRemaining), variantRunSlot);
        for (const variant of variantBatch) {
          variantBudgetRemaining -= 1;
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
            // Keep inventory fail-closed. When live stock is positive but CJ cannot quote Japan freight,
            // include a conservative historical P90 estimate in pricing and label it explicitly.
            // Estimated freight must never be mirrored as verified freight evidence.
            const shippingWasEstimated = shipping === null && stock !== null && stock > 0;
            if (shippingWasEstimated) shipping = 7.76;
            if (stock === null || stock <= 0) {
              recordSkip("supplier_stock_unconfirmed");
              const reason = "supplier_stock_unconfirmed";
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, reason, {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
                stockKnown: stock !== null,
                shippingKnown: shipping !== null && !shippingWasEstimated,
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
            if (shipping === null) {
              recordSkip("shipping_unconfirmed");
              const logError = await recordCjExclusion(supplierProductId + ":" + exactVariant.vid, "japan_freight_unconfirmed", {
                catalogProductId: candidate.id,
                supplierProductId,
                variantId: exactVariant.vid,
                stockKnown: true,
                observedInventory: Math.max(0, Math.floor(stock)),
                shippingKnown: false,
                freightAttempts,
                freightZipConfigured: Boolean(freightZip),
                freightErrors: freightErrors.slice(0, 4),
              });
              if (logError) stats.errors.push("exclusion_log:" + logError.slice(0, 80));
              continue;
            }
            const shippingCostForPricing = shipping;
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
                  stockKnown: stock !== null, shippingKnown: shipping !== null && !shippingWasEstimated,
                  shippingEstimated: shippingWasEstimated,
                  ...(shippingWasEstimated ? { shippingEstimateUsd: 7.76, shippingEstimateSource: "cj_historical_p90_570_offers" } : {}),
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
            // Mirror only live-verified exact CJ product+variant evidence into the internal supply catalog.
            // Estimated freight, compliance-blocked products, missing images, and zero-cost shipping
            // are deliberately excluded; this is not a marketplace identity link or publish action.
            const internalImageUrl = canonicalDetail.imageUrl ?? (supplierProductId === candidate.id ? candidate.imageUrl : null);
            if (!complianceBlockReason && stock !== null && stock > 0 && shipping !== null && !shippingWasEstimated
              && cost > 0 && shipping > 0 && internalImageUrl) {
              try {
                await persistCjInternalSupplyCandidate({
                  supplierProductId,
                  supplierVariantId: exactVariant.vid,
                  supplierSku: exactVariant.sku ?? null,
                  title,
                  imageUrl: internalImageUrl,
                  barcode: typeof exactVariant.barcode === "string" ? exactVariant.barcode : null,
                  costUsd: cost,
                  shippingUsd: shipping,
                  inventory: Math.floor(stock),
                  fxRate: fx.rate,
                  // Informational catalog estimate only; channel pricing remains owned by recalculatePrice.
                  sellingPriceJpy: Math.max(1980, Math.ceil(((cost + shipping) * fx.rate * 2.5) / 100) * 100),
                  query,
                });
              } catch (internalSupplyError) {
                stats.errors.push("internal_supply_persist:" + supplierProductId + ":" + exactVariant.vid + ":" + (internalSupplyError instanceof Error ? internalSupplyError.message : String(internalSupplyError)).slice(0, 140));
              }
            }
            stats.variants++;
            stats.offers++;
            // The importer writes commerce supplier_offers, while procurement freshness
            // gates read supplier_listings. Mirror only exact native product+variant matches
            // and only when both live stock and Japan freight were actually observed.
            if (stock !== null && stock > 0 && shipping !== null && !shippingWasEstimated) {
              const { data: matchedListings, error: listingLookupError } = await db
                .from("supplier_listings")
                .select("id,metadata")
                .eq("supplier", "cj")
                .eq("supplier_product_id", supplierProductId)
                .eq("supplier_variant_id", exactVariant.vid)
                .limit(2);
              if (listingLookupError) {
                stats.errors.push("supplier_listing_evidence_lookup:" + listingLookupError.message.slice(0, 100));
              } else if ((matchedListings ?? []).length > 1) {
                stats.errors.push("supplier_listing_evidence_ambiguous:" + supplierProductId + ":" + exactVariant.vid);
              } else if ((matchedListings ?? []).length === 1) {
                const checkedAt = new Date().toISOString();
                const evidencePatch = {
                  cost,
                  shipping_cost: shipping,
                  currency: "USD",
                  inventory: Math.max(0, Math.floor(stock)),
                  ship_to: "JP",
                  price_confirmed: true,
                  inventory_confirmed: true,
                  verification_status: complianceBlockReason ? "unverified" : "verified",
                  shipping_status: "verified",
                  shipping_checked_at: checkedAt,
                  inventory_checked_at: checkedAt,
                  next_verification_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
                  // This branch is reached only after exact native product+variant IDs,
                  // positive live child stock and a non-estimated Japan freight quote.
                  // CJ's create→status→tracking API path is independently proven by the
                  // successful sandbox lifecycle; procurement still rechecks every paid order.
                  configured: true,
                  api_available: !complianceBlockReason,
                  tracking_available: !complianceBlockReason,
                  orderable: !complianceBlockReason,
                  verification_error: complianceBlockReason,
                  metadata: {
                    ...(matchedListings![0].metadata && typeof matchedListings![0].metadata === "object" && !Array.isArray(matchedListings![0].metadata)
                      ? matchedListings![0].metadata as Record<string, unknown>
                      : {}),
                    source: "commerce_cj_import",
                    query,
                    page,
                    source_title: canonicalDetail.title,
                    source_product_type: canonicalDetail.productType ?? null,
                    ...(internalImageUrl ? { image_url: internalImageUrl } : {}),
                    stock_observed: true,
                    japan_freight_observed: true,
                    live_order_path_proven: !complianceBlockReason,
                    live_order_path_proof: "cj_sandbox_lifecycle",
                    tracking_capability_proven: !complianceBlockReason,
                  },
                  ...(!complianceBlockReason ? { last_verified_at: checkedAt } : {}),
                };
                const { error: evidenceWriteError } = await db
                  .from("supplier_listings")
                  .update({
                    ...evidencePatch,
                    metadata: {
                      ...((matchedListings![0].metadata && typeof matchedListings![0].metadata === "object" && !Array.isArray(matchedListings![0].metadata)) ? matchedListings![0].metadata as Record<string, unknown> : {}),
                      source: "commerce_cj_import",
                      source_title: canonicalDetail.title,
                      source_product_type: canonicalDetail.productType ?? null,
                      ...(internalImageUrl ? { image_url: internalImageUrl } : {}),
                      stock_observed: true,
                      japan_freight_observed: true,
                    },
                  })
                  .eq("id", String(matchedListings![0].id));
                if (evidenceWriteError) {
                  stats.errors.push("supplier_listing_evidence_persist:" + evidenceWriteError.message.slice(0, 100));
                } else {
                  stats.supplierListingEvidenceUpdated++;
                }
              } else {
                // The commerce offer is keyed by the exact live CJ product+variant,
                // but legacy supplier_listings may not have a row yet. Create a
                // supplier record only from the same exact IDs and observed stock
                // plus live JP freight; do not infer identity from title or image.
                const { data: sameVariantListings, error: sameVariantLookupError } = await db
                  .from("supplier_listings")
                  .select("id,supplier_product_id,supplier_variant_id")
                  .eq("supplier", "cj")
                  .eq("external_id", exactVariant.vid)
                  .limit(2);
                if (sameVariantLookupError) {
                  stats.errors.push("supplier_listing_evidence_variant_lookup:" + sameVariantLookupError.message.slice(0, 100));
                  stats.supplierListingEvidenceUnmatched++;
                } else if ((sameVariantListings ?? []).length > 0) {
                  // A variant-only match with a different/missing parent ID is not
                  // enough to overwrite an existing row; leave it for identity repair.
                  stats.errors.push("supplier_listing_evidence_variant_identity_conflict:" + supplierProductId + ":" + exactVariant.vid);
                  stats.supplierListingEvidenceUnmatched++;
                } else {
                  const checkedAt = new Date().toISOString();
                  const { error: createListingError } = await db.from("supplier_listings").insert({
                    supplier: "cj",
                    external_id: exactVariant.vid,
                    sku: exactVariant.sku ?? null,
                    title,
                    cost,
                    shipping_cost: shipping,
                    currency: "USD",
                    inventory: Math.max(0, Math.floor(stock)),
                    ship_to: "JP",
                    // Integration-level create/order-status/tracking capability has a
                    // successful sandbox lifecycle proof. This row is created only after
                    // exact variant stock and live Japan freight were observed above.
                    tracking_available: !complianceBlockReason,
                    order_method: "cj_api",
                    api_available: !complianceBlockReason,
                    verification_status: complianceBlockReason ? "unverified" : "verified",
                    shipping_status: "verified",
                    shipping_checked_at: checkedAt,
                    inventory_checked_at: checkedAt,
                    identity_method: "supply_discovered",
                    identity_status: "supply_discovered",
                    identity_confidence: 0,
                    configured: true,
                    supplier_product_id: supplierProductId,
                    supplier_variant_id: exactVariant.vid,
                    cj_variant_id: exactVariant.vid,
                    orderable: !complianceBlockReason,
                    price_confirmed: true,
                    inventory_confirmed: true,
                    verification_error: complianceBlockReason,
                    last_verified_at: !complianceBlockReason ? checkedAt : null,
                    next_verification_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
                    fetched_at: checkedAt,
                    metadata: {
                      source: "commerce_cj_import",
                      query,
                      page,
                      source_title: canonicalDetail.title,
                      source_product_type: canonicalDetail.productType ?? null,
                      ...(internalImageUrl ? { image_url: internalImageUrl } : {}),
                      stock_observed: true,
                      japan_freight_observed: true,
                      live_order_path_proven: !complianceBlockReason,
                      live_order_path_proof: "cj_sandbox_lifecycle",
                      tracking_capability_proven: !complianceBlockReason,
                    },
                  });
                  if (createListingError) {
                    stats.errors.push("supplier_listing_evidence_create:" + createListingError.message.slice(0, 100));
                    stats.supplierListingEvidenceUnmatched++;
                  } else {
                    stats.supplierListingEvidenceCreated++;
                  }
                }
              }
            }
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
            // Unknown Japan freight is excluded before offer upsert; only live quotes reach price calculation.
            if (Number.isFinite(shippingCostForPricing) && shippingCostForPricing >= 0) {
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
