/**
 * Builds conservative Japanese product copy only when the title carries
 * enough product-specific evidence. It never invents measurements, material
 * composition, compatibility, or performance beyond what the source title says.
 */
export function buildSourceGroundedJapaneseDescription(title: string, sourceTitle = ""): string | null {
  const normalized = title.normalize("NFKC").replace(/\s+/g, " ").trim();
  const source = sourceTitle.normalize("NFKC").replace(/\s+/g, " ").trim();
  const combined = (normalized + " " + source).toLocaleLowerCase("ja-JP");
  const sourceLower = source.toLocaleLowerCase("ja-JP");

  if (/透かし編み|woven hollowed|woven handbag/.test(combined)) {
    return "透かし編みデザインのサマーハンドバッグです。編み目の表情を楽しめるデザインで、春夏の外出スタイルに合わせやすい一品です。サイズ・素材・開口部・内ポケット・付属品は販売元の最新仕様をご確認ください。";
  }
  if (/ノートpc収納|パソコン収納|laptop handbag|laptop bag/.test(combined)) {
    return "ノートPC収納対応と商品名に記載されたレディースバッグです。通勤や移動時にPCと日用品をまとめて持ち運ぶ用途に向いています。対応PCサイズ・収納寸法・素材・重量・仕切りの構成は販売元の最新仕様をご確認ください。";
  }
  if (/防水|waterproof/.test(combined) && /トラベルバッグ|旅行.*バッグ|travel bag|travel backpack/.test(combined)) {
    return "商品名に防水仕様と記載されたトラベルバッグです。旅行やジム用品の持ち運びを想定した形状です。防水性能・収納区画・シューズ収納の有無・寸法は販売元の最新仕様をご確認ください。";
  }
  if (/透明|クリア素材|transparent|clear/.test(combined) && /バッグ|bag|tote|crossbody/.test(combined)) {
    return "透明素材と商品名に記載されたレディースバッグです。中身が見えるデザインを活かして小物を持ち運べます。素材・寸法・開口部・ストラップ仕様は販売元の最新仕様をご確認ください。";
  }
  if (/puレザー|ヴィーガンレザー|vegan leather|pu leather|oil wax leather/.test(combined) && /バッグ|bag|shoulder|tote|hobo|messenger/.test(combined)) {
    return "商品名にPUレザー、ヴィーガンレザー、またはオイルワックスレザーと記載されたレディースバッグです。レトロな形状や肩掛けスタイルをコーディネートのアクセントとして楽しめます。実際の素材表記・寸法・ストラップ調整幅・収納部は販売元の最新仕様をご確認ください。";
  }
  if (/キャンバス|canvas/.test(combined) && /バッグ|bag|rucksack|backpack/.test(combined)) {
    return "キャンバス素材と商品名に記載されたカジュアルなバッグです。日常のお出かけで小物や日用品を持ち運ぶ用途に使えます。素材組成・サイズ・収納部・持ち手や肩ひもの仕様は販売元の最新情報をご確認ください。";
  }
  if (/タッセル|tassel/.test(combined) && /バッグ|bag/.test(combined)) {
    return "タッセル装飾を取り入れたレディースハンドバッグです。装飾をコーディネートのアクセントとして楽しめます。サイズ・素材・収納部・持ち手仕様は販売元の最新情報をご確認ください。";
  }

  const bagHasDistinctiveDetail = /vintage|retro|canvas|leather|tassel|large capacity|mini|small|woven|hollowed|waterproof|transparent|clear|satin|velvet|flower|floral|rhinestone|pearl|bow|metal|alloy|denim|nylon|oxford|cotton|foldable|folding|portable|multi.?pocket|zipper|crossbody|hobo|saddle|clutch|chain|plush|embroidery|embroidered|straw|raffia|beaded|checkerboard|wavy|cartoon|geometric|star|heart|summer|sports|travel|laptop|shoulder|tote|oil wax/i.test(sourceLower)
    || /レトロ|キャンバス|レザー|タッセル|大容量|ミニ|小型|透かし編み|防水|透明|クリア|サテン|ベルベット|花柄|ラインストーン|パール|リボン|メタル|デニム|ナイロン|折りたたみ|ポケット|ファスナー|斜め掛け|ホーボー|チェーン|刺繍|麦わら|ビーズ|チェッカー|ウェーブ|幾何学|スター|ハート|サマー|トラベル|ノートpc|オイルワックス/i.test(normalized);
  if (/ショルダーバッグ|shoulder bag|crossbody|cross body/.test(combined) && bagHasDistinctiveDetail) {
    return "商品名に記載されたデザインのレディースショルダーバッグです。肩掛けや斜め掛けで持ち運べる形状で、日常のお出かけに使えます。サイズ・素材・ストラップ調整幅・ポケット仕様は販売元の最新情報をご確認ください。";
  }
  if (/ハンドバッグ|handbag|tote bag|トートバッグ/.test(combined) && bagHasDistinctiveDetail) {
    return "商品名に記載されたデザインのレディースハンドバッグです。日常のお出かけで小物や日用品を持ち運ぶ用途に使えます。サイズ・素材・開口部・収納部・持ち手仕様は販売元の最新情報をご確認ください。";
  }

  const cosmeticBagHasDetail = /large.capacity|waterproof|divider|multi.grid|pockets|hanging|portable|travel|organizer|folding|仕切り|大容量|防水|多層|ポケット|吊り下げ|携帯用|旅行|折りたたみ/i.test(sourceLower + " " + normalized);
  if (/コスメポーチ|メイクポーチ|化粧ポーチ|cosmetic bag|makeup organizer|make up bag/.test(combined) && cosmeticBagHasDetail) {
    return "メイク用品や旅行小物を整理するコスメポーチです。仕切りやポケットの構成は商品画像で確認し、寸法・素材・収納可能なサイズは販売元の最新仕様をご確認ください。";
  }

  const brushCount = source.match(/(\d{1,2})\s*(?:pcs|pieces|piece|makeup\s+brush(?:es)?|brushes|brush\s+set|本|本セット)/i)?.[1];
  if (/メイクブラシ|makeup brush/.test(combined) && (brushCount || /wooden|portable|multi.color|soft hair|eyes?h?adow|beginner|木製|携帯用|多色|柔らか毛|初心者/i.test(sourceLower + " " + normalized))) {
    return `メイクに使うブラシセットです。${brushCount ? `商品名には${brushCount}本セットと記載されています。` : ""}ブラシの本数・毛質・形状・セット内容・お手入れ方法は販売元の最新仕様をご確認ください。`;
  }

  if (/メイクパフ|メイクスポンジ|makeup sponge|beauty egg|きのこ型/.test(combined) && /mini|small|egg|mushroom|portable|beauty egg|きのこ型|卵型|コンパクト|携帯用/i.test(sourceLower + " " + normalized)) {
    return "ファンデーションなどのメイクに使うメイクスポンジです。商品名に記載された形状を商品画像で確認し、材質・寸法・洗浄方法・セット内容は販売元の最新仕様をご確認ください。";
  }

  const hairClipHasDetail = /ribbon|pearl|metal|satin|wool|crochet|frog|butterfly|glitter|checkerboard|matte|star|heart|rhinestone|bow|acetate|geometric|cartoon|flower|colorful|ハート|パール|メタル|サテン|手編み|カエル|蝶|ラメ|チェッカー|マット|スター|リボン|ラインストーン|幾何学|花柄|カラフル/i.test(sourceLower + " " + normalized);
  if (/ヘアクリップ|ヘアピン|hair clip|barrette|hair claw/.test(combined) && hairClipHasDetail) {
    return "商品名に記載されたモチーフや素材表記を活かしたヘアクリップです。髪をまとめたり、ヘアスタイルのアクセントとして使えます。サイズ・材質・留め具の仕様は販売元の最新情報をご確認ください。";
  }

  const headbandHasDetail = /boho|wide|velvet|rhinestone|peacock|crochet|sports|chain|satin|wide brim|ボヘミアン|幅広|ベルベット|ラインストーン|孔雀|手編み|スポーツ|チェーン|サテン/i.test(sourceLower + " " + normalized);
  if (/ヘアバンド|カチューシャ|ヘッドバンド|headband|hair band/.test(combined) && headbandHasDetail) {
    return "商品名に記載されたデザインのヘアバンドです。髪をまとめたり、ヘアスタイルのアクセントとして使えます。幅・素材・伸縮性・カラーは販売元の最新仕様をご確認ください。";
  }

  if (/洗顔ブラシ|フェイスブラシ|facial brush|face cleaning brush/.test(combined) && /bamboo charcoal|soft hair|massage|竹炭|柔らか毛|マッサージ|電動|soft bristle/i.test(sourceLower + " " + normalized)) {
    return "洗顔時に使うフェイスブラシです。商品名に記載された毛質や形状は商品画像と仕様表で確認し、使用方法・お手入れ方法・使用上の注意は販売元の最新情報をご確認ください。";
  }
  return null;
}
