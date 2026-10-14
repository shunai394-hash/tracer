const SPECIFIC_TITLE_RULES: Array<[RegExp, string]> = [
  [/50ml aromatherapy machine|timed automatic spraying fragrance|automatic spraying fragrance.*diffuser/i, "タイマー付き 自動噴霧アロマディフューザー"],
  [/sun protection clothing.*strappy skirt|beach seaside resort strappy skirt/i, "リゾートデザイン ストラップスカート"],
  [/beauty dechlorinating dual filter shower head|dual filter shower head.*kdf filter/i, "二重フィルター付き シャワーヘッド"],
  [/acrylic.*knitted headband|knitted headband.*women|crossed hair accessories.*women/i, "ニット編み クロスヘアバンド"],
  [/padded canvas belt backpack.*women|women.*padded canvas belt backpack/i, "レディース キャンバス ベルト付きリュック"],
  [/silicone shampoo brush|shampoo brush.*scalp/i, "シリコン製 頭皮ケアブラシ"],
  [/butterfly.*phone case|phone case.*butterfly/i, "バタフライ柄 スマホケース"],
  [/flannel nightgown.*pineapple plaid|pineapple plaid.*flannel nightgown/i, "チェック柄 フランネル ロングルームウェア"],
  [/groin electric clippers|groin hair clipper|pubic hair trimmer/i, "デリケートゾーン用 電動トリマー"],
  [/graffiti art.*african girl.*shower curtain|african girl.*shower curtain/i, "アフリカンアート柄 シャワーカーテン"],
  [/portable cosmetic bag.*(divider|multi.grid|pockets)|cosmetic bag.*(divider|multi.grid|pockets)/i, "仕切り付き コスメポーチ"],
  [/\b(women|women's|female)\b.{0,50}(cosmetic|makeup) bag|((cosmetic|makeup) bag).{0,50}\b(women|women's|female)\b/i, "レディース コスメポーチ"],
  [/flower.*hair clip|hair clip.*flower|bohemian.*hair clip/i, "フラワーモチーフ ヘアクリップ"],
  [/hair clip|claw clip|hair claw/i, "ヘアクリップ"],
  [/cosmetic brush storage|makeup brush.*storage|makeup brush cleaner/i, "メイクブラシ収納・お手入れ用品"],
  [/women.{0,60}crossbody.{0,40}bag|crossbody.{0,40}bag.{0,60}women/i, "レディース クロスボディバッグ"],
  [/women.{0,60}shoulder.{0,40}bag|shoulder.{0,40}bag.{0,60}women/i, "レディース ショルダーバッグ"],
  [/women.{0,60}tote.{0,40}bag|tote.{0,40}bag.{0,60}women/i, "レディース トートバッグ"],
  [/women.{0,60}handbag|handbag.{0,60}women/i, "レディース ハンドバッグ"],
  [/a4\s+portable\s+printers?|thermal printer.*phomemo|phomemo.*thermal printer/i, "A4対応 ポータブル感熱プリンター"],
  [/jellyfish.*humidifier|humidifier.*jellyfish/i, "クラゲ型 加湿器・アロマディフューザー"],
  [/kitchen bathroom toilet cleaning magic brush|bath brush.*glass wall|window slot clean brush/i, "浴室・窓まわり用 クリーニングブラシ"],
  [/ceramic mug.*wooden handle|wooden handle.*filter tea cup|filter tea cup with lid/i, "木製ハンドル付き セラミックティーカップ"],
  [/leather.*phone case|phone case.*leather/i, "レザー調 スマホケース"],
  [/bunny.*cashmere warm cushion|bunny.*cushion.*fleece/i, "うさぎモチーフ ふんわりチェアクッション"],
  [/a4 paper printing copy paper|copy paper 70g/i, "A4コピー用紙 70g/m²・500枚入り"],
  [/northern lights.*music star projector|star projector lamp|cornucopia.*projector/i, "オーロラ・星空プロジェクターライト"],
  [/retro large-diameter.*potted pot|potted pot decoration/i, "レトロデザイン 卓上プランター"],
  [/straw covers cap.*cowboy hat|cowboy hat shaped.*straw topper/i, "カウボーイハット型 ストローカバー"],
  [/hd large mirror.*magnifying glass|magnifying glass.*stand/i, "スタンド付き 拡大鏡"],
  [/car decorations.*led ambient lights|interior led ambient lights/i, "車内LEDアンビエントライト"],
  [/three-dimensional piggy butt.*phone case|piggy butt phone case/i, "ぶたモチーフ シリコンスマホケース"],
  [/flowers.*phone case|flower.*phone case/i, "フラワーモチーフ スマホケース"],
  [/retro.*cowhide backpack|crazy horse cowhide.*backpack/i, "レトロデザイン レザー調レディースリュック"],
  [/shoes.*women.*inner height increase|inner height increase.*women.*shoes/i, "インヒール レディースシューズ"],
  [/soft memory foam travel neck pillow|travel neck pillow.*memory foam/i, "低反発 トラベルネックピロー"],
  [/hooded travel pillow.*inflatable neck pillow|inflatable neck pillow/i, "空気注入式 トラベルネックピロー"],
  [/square non.slip bathroom mat.*suction cup|bathroom mat.*suction cup/i, "吸盤付き 滑り止めバスマット"],
  [/beauty salon floor towel|floor towel.*floor mat/i, "美容サロン用 フロアタオル"],
  [/high.value water cup.*heat.resistant glass.*flower tea cup|heat.resistant glass flower tea cup/i, "花柄 耐熱ガラスティーカップ"],
  [/micro.current massager.*eye|eye.*micro.current massager/i, "目元用 マイクロカレント美顔器"],
  [/eye beauty instrument home hot compress|eye patch.*pair/i, "目元用 温熱ケアパッド"],
  [/cosmetic jewelry rack.*three grids|cosmetic jewelry rack/i, "コスメ・アクセサリー収納スタンド"],
  [/14.inch makeup.*storage box|makeup.*portable storage box/i, "14インチ対応 メイク収納ケース"],
  [/crystal jade chakra combination set.*bracelet|chakra combination set.*bracelet/i, "クリスタル調デザイン ブレスレットセット"],
];

const CATEGORY_ONLY_TITLES = new Set([
  "スマホ保護アクセサリー",
  "暮らしの便利アイテム",
  "インテリア照明",
  "キッチン用品",
  "ペット用品",
  "バスルームマット",
  "トレンド・seeded_dueアイテム",
]);

const TITLE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bwireless\b/gi, "ワイヤレス"], [/\bportable\b/gi, "ポータブル"], [/\brechargeable\b/gi, "充電式"],
  [/\bwaterproof\b/gi, "防水"], [/\btravel\b/gi, "トラベル"], [/\bmini\b/gi, "ミニ"], [/\blarge\b/gi, "大容量"],
  [/\bsmall\b/gi, "コンパクト"], [/\bsoft\b/gi, "ソフト"], [/\bhard\b/gi, "ハード"], [/\bfoldable\b/gi, "折りたたみ"],
  [/\bportable\s+makeup\s+bag\b/gi, "メイクポーチ"], [/\bmakeup\s+bag\b/gi, "メイクポーチ"],
  [/\bcosmetic\s+bag\b/gi, "コスメポーチ"], [/\btoiletry\s+bag\b/gi, "トラベルポーチ"],
  [/\bhandbag\b/gi, "ハンドバッグ"], [/\bcrossbody\s+bag\b/gi, "ショルダーバッグ"], [/\btote\s+bag\b/gi, "トートバッグ"],
  [/\bbackpack\b/gi, "リュック"], [/\bwallet\b/gi, "財布"], [/\bcard\s+holder\b/gi, "カードケース"],
  [/\bnecklace\b/gi, "ネックレス"], [/\bearrings?\b/gi, "ピアス"], [/\bbracelet\b/gi, "ブレスレット"],
  [/\bring\b/gi, "リング"], [/\bhair\s+clip\b/gi, "ヘアクリップ"], [/\bhair\s+claw\b/gi, "ヘアクリップ"],
  [/\bmakeup\s+brush\b/gi, "メイクブラシ"], [/\bmakeup\b/gi, "メイク"], [/\blipstick\b/gi, "リップスティック"],
  [/\blip\s+gloss\b/gi, "リップグロス"], [/\blip\s+tint\b/gi, "リップティント"], [/\bmascara\b/gi, "マスカラ"],
  [/\beyeliner\b/gi, "アイライナー"], [/\beyeshadow\b/gi, "アイシャドウ"], [/\bblush\b/gi, "チーク"],
  [/\bconcealer\b/gi, "コンシーラー"], [/\bserum\b/gi, "美容液"], [/\bmoisturizer\b/gi, "保湿クリーム"],
  [/\bface\s+cream\b/gi, "フェイスクリーム"], [/\bsunscreen\b/gi, "日焼け止め"], [/\btoner\b/gi, "化粧水"],
  [/\bessence\b/gi, "美容エッセンス"], [/\bcleansing\s+(oil|balm)\b/gi, "クレンジング"],
  [/\bshampoo\b/gi, "シャンプー"], [/\bconditioner\b/gi, "コンディショナー"], [/\bhair\s+dryer\b/gi, "ヘアドライヤー"],
  [/\bhair\s+curler\b/gi, "ヘアカーラー"], [/\bhair\s+straightener\b/gi, "ストレートアイロン"],
  [/\bhair\s+brush\b/gi, "ヘアブラシ"], [/\bscalp\s+massager\b/gi, "頭皮マッサージャー"],
  [/\bskincare\b/gi, "スキンケア"], [/\bbeauty\b/gi, "美容"], [/\bcosmetic(s)?\b/gi, "コスメ"],
  [/\bjewelry\b/gi, "アクセサリー"], [/\baccessor(y|ies)\b/gi, "アクセサリー"], [/\bshoes?\b/gi, "シューズ"],
  [/\bsneakers?\b/gi, "スニーカー"], [/\bdress\b/gi, "ワンピース"], [/\bshirt\b/gi, "シャツ"], [/\btop\b/gi, "トップス"],
  [/\bskirt\b/gi, "スカート"], [/\bpants?\b/gi, "パンツ"], [/\bleggings\b/gi, "レギンス"],
  [/\bbra\b/gi, "ブラ"], [/\bshapewear\b/gi, "補整インナー"], [/\borganizer\b/gi, "収納ケース"],
  [/\bstorage\b/gi, "収納"], [/\bgarment\s+steamer\b/gi, "衣類スチーマー"], [/\bsteamer\b/gi, "スチーマー"],
  [/\bhumidifier\b/gi, "加湿器"], [/\blamp\b/gi, "ライト"], [/\blighting\b/gi, "照明"],
  [/\bphone\s+case\b/gi, "スマホケース"], [/\bphone\s+holder\b/gi, "スマホホルダー"], [/\bstand\b/gi, "スタンド"],
  [/\bpet\b/gi, "ペット"], [/\bcat\b/gi, "猫"], [/\bdog\b/gi, "犬"], [/\btoy\b/gi, "おもちゃ"],
  [/\bwater\s+bottle\b/gi, "ボトル"], [/\bbottle\b/gi, "ボトル"], [/\bcup\b/gi, "カップ"],
  [/\bcase\b/gi, "ケース"], [/\bbag\b/gi, "バッグ"], [/\bstrap\b/gi, "ストラップ"],
  [/\bholder\b/gi, "ホルダー"], [/\bkit\b/gi, "セット"], [/\bset\b/gi, "セット"],
  [/\bblack\b/gi, "ブラック"], [/\bwhite\b/gi, "ホワイト"], [/\bbeige\b/gi, "ベージュ"], [/\bpink\b/gi, "ピンク"],
  [/\bblue\b/gi, "ブルー"], [/\bgreen\b/gi, "グリーン"], [/\bbrown\b/gi, "ブラウン"],
  [/\biphone|smartphone|mobile\b/gi, "スマホ"], [/\btempered\s+(glass|film)|screen\s+protector\b/gi, "保護フィルム"],
  [/\bvase|flower\s+arrangement\b/gi, "フラワーベース"], [/\btoilet\s+brush\b/gi, "トイレブラシ"],
  [/\bbathroom\s+(mat|rug)|floor\s+mat\b/gi, "バスマット"], [/\bshaver|razor\b/gi, "シェーバー"],
  [/\bmakeup\s+sponge|sponge\s+puff\b/gi, "メイクスポンジ"], [/\bair\s+conditioner|air\s+cooler|cooling\s+fan\b/gi, "冷風機"],
  [/\bfan\b/gi, "ファン"], [/\bcat\s+trinket|cat\s+craft\b/gi, "猫モチーフ雑貨"],
  [/\bteapot|coffee\s+table\b/gi, "ティータイム雑貨"], [/\bswimming\s+pool\b/gi, "家庭用プール"],
  [/\bbrush\b/gi, "ブラシ"], [/\bmat\b/gi, "マット"], [/\bflower\b/gi, "フラワー"],
];

const FALLBACK_TITLE_RULES: Array<[RegExp, string]> = [
  [/iphone|smartphone|mobile|phone|tempered|screen protector/i, "スマホ保護アクセサリー"],
  [/vase|flower arrangement/i, "フラワーベース"],
  [/toilet brush/i, "トイレブラシ"],
  [/bathroom|shower|floor mat|foot mat/i, "バスルームマット"],
  [/shaver|razor/i, "電動シェーバー"],
  [/makeup|cosmetic|beauty/i, "美容・メイクアイテム"],
  [/hair|scalp/i, "ヘアケアアイテム"],
  [/bag|wallet|purse/i, "バッグ・収納アイテム"],
  [/jewelry|necklace|earring|bracelet/i, "アクセサリー"],
  [/cat|dog|pet/i, "ペット用品"],
  [/kitchen|cup|bottle|cooking/i, "キッチン用品"],
  [/fan|air conditioner|cooler/i, "冷風・送風アイテム"],
  [/lamp|light|lighting/i, "インテリア照明"],
  [/pool|swimming/i, "レジャー用品"],
];

export function localizeProductTitle(value: unknown, category?: string | null): string | null {
  if (typeof value !== "string") return null;
  const source = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!source) return null;

  // Specific, source-grounded product names must win over broad category rules.
  const specific = SPECIFIC_TITLE_RULES.find(([pattern]) => pattern.test(source));
  if (specific) return specific[1];

  let title = source;
  for (const [pattern, replacement] of TITLE_REPLACEMENTS) title = title.replace(pattern, replacement);
  title = title.replace(/\s*[-|•]+\s*/g, "・").replace(/\s{2,}/g, " ").trim();
  if (isJapaneseProductTitle(title)) {
    const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
    const latin = (title.match(/[A-Za-z]/g) ?? []).length;
    if (latin <= japanese * 1.5) return title.slice(0, 120);
  }

  // A category label is not a product title. If the caller says the stored
  // title is only a generic category and no specific source rule matched,
  // stop sync instead of publishing another indistinguishable listing.
  if (typeof category === "string" && CATEGORY_ONLY_TITLES.has(category.normalize("NFKC").trim())) return null;

  const fallback = FALLBACK_TITLE_RULES.find(([pattern]) => pattern.test(source));
  if (fallback) return fallback[1];
  if (typeof category === "string" && category.trim()) return "トレンド・" + category.trim().slice(0, 20) + "アイテム";
  return null;
}

export function localizeProductDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.normalize("NFKC");
  const rules: Array<[RegExp, string]> = [
    [/50ml aromatherapy machine|timed automatic spraying fragrance|automatic spraying fragrance.*diffuser/i, "香りを噴霧する家庭用アロマディフューザーです。容量・噴霧間隔・給電方式・対応する香料は販売元の仕様をご確認ください。"],
    [/sun protection clothing.*strappy skirt|beach seaside resort strappy skirt/i, "リゾートスタイルのストラップスカートです。素材・サイズ・着用感・洗濯方法は販売元の仕様をご確認ください。"],
    [/beauty dechlorinating dual filter shower head|dual filter shower head.*kdf filter/i, "フィルターを備えたシャワーヘッドです。対応フィルター・取付規格・性能については販売元の仕様をご確認ください。"],
    [/acrylic.*knitted headband|knitted headband.*women|crossed hair accessories.*women/i, "柔らかなニット素材のクロスヘアバンドです。サイズ・素材・カラー・着用感は販売元の仕様をご確認ください。"],
    [/padded canvas belt backpack.*women|women.*padded canvas belt backpack/i, "キャンバス素材のベルト付きリュックです。寸法・収納部・ベルト仕様・素材は販売元の仕様をご確認ください。"],
    [/silicone shampoo brush|shampoo brush.*scalp/i, "シリコン製の頭皮ケアブラシです。素材・サイズ・使用方法・お手入れ方法は販売元の仕様をご確認ください。"],
    [/butterfly.*phone case|phone case.*butterfly/i, "バタフライ柄のスマートフォンケースです。対応機種・素材・付属品は商品バリエーションと販売元の仕様をご確認ください。"],
    [/flannel nightgown.*pineapple plaid|pineapple plaid.*flannel nightgown/i, "チェック柄のフランネル素材を使ったロング丈ルームウェアです。素材構成・サイズ・洗濯方法は販売元の仕様をご確認ください。"],
    [/women.{0,60}(crossbody|shoulder|tote|handbag).{0,40}bag|((crossbody|shoulder|tote|handbag).{0,40}bag).{0,60}women/i, "日常のお出かけに使うバッグです。寸法・素材・収納部・ストラップ仕様は販売元の情報をご確認ください。"],
    [/portable cosmetic bag.*(divider|multi.grid|pockets)|cosmetic bag.*(divider|multi.grid|pockets)/i, "小物を分けて収納できるコスメポーチです。寸法・仕切り構成・素材・防水性は販売元の仕様をご確認ください。"],
    [/flower.*hair clip|hair clip.*flower|bohemian.*hair clip/i, "花モチーフのヘアクリップです。サイズ・材質・留め具の仕様は販売元の情報をご確認ください。"],
    [/hair clip|claw clip|hair claw/i, "髪をまとめるためのヘアクリップです。サイズ・材質・保持力は販売元の仕様をご確認ください。"],
    [/cosmetic brush storage|makeup brush.*storage|makeup brush cleaner/i, "メイクブラシの収納またはお手入れに使う用品です。対応サイズ・洗浄方法・材質は販売元の仕様をご確認ください。"],
    [/a4\s+portable\s+printers?|thermal printer.*phomemo|phomemo.*thermal printer/i, "A4サイズの用紙に対応する携帯型感熱プリンターです。対応用紙・接続方式・付属品は販売元の仕様をご確認ください。"],
    [/jellyfish.*humidifier|humidifier.*jellyfish/i, "クラゲ型デザインの加湿器・ディフューザーです。給電方式・タンク容量・使用可能な香料は販売元の仕様をご確認ください。"],
    [/kitchen bathroom toilet cleaning magic brush|bath brush.*glass wall|window slot clean brush/i, "浴室や窓まわりの清掃に使うブラシです。対応する面材や使用方法は販売元の仕様をご確認ください。"],
    [/ceramic mug.*wooden handle|wooden handle.*filter tea cup|filter tea cup with lid/i, "木製ハンドル付きのセラミックカップです。容量・耐熱性・電子レンジ対応は販売元の仕様をご確認ください。"],
    [/leather.*phone case|phone case.*leather/i, "レザー調デザインのスマートフォンケースです。対応機種・素材・付属品は商品バリエーションと販売元の仕様をご確認ください。"],
    [/bunny.*cashmere warm cushion|bunny.*cushion.*fleece/i, "うさぎモチーフの起毛クッションです。寸法・素材・お手入れ方法は販売元の仕様をご確認ください。"],
    [/a4 paper printing copy paper|copy paper 70g/i, "A4サイズのコピー用紙です。厚さ・枚数・対応プリンターは販売元の仕様をご確認ください。"],
    [/northern lights.*music star projector|star projector lamp|cornucopia.*projector/i, "星空やオーロラ風の光を楽しむプロジェクターライトです。投影機能・給電方式・付属品は販売元の仕様をご確認ください。"],
    [/retro large-diameter.*potted pot|potted pot decoration/i, "卓上で使うプランター・鉢カバーです。寸法・素材・設置条件は販売元の仕様をご確認ください。"],
    [/straw covers cap.*cowboy hat|cowboy hat shaped.*straw topper/i, "ストロー先端に装着するカバーです。対応するストロー径・材質・耐熱性は販売元の仕様をご確認ください。"],
    [/hd large mirror.*magnifying glass|magnifying glass.*stand/i, "スタンド付きの拡大鏡です。レンズ径・倍率・固定方法は販売元の仕様をご確認ください。"],
    [/car decorations.*led ambient lights|interior led ambient lights/i, "車内用のLEDアンビエントライトです。電源方式・車種との適合・配線方法は販売元の仕様をご確認ください。"],
    [/three-dimensional piggy butt.*phone case|piggy butt phone case|flowers.*phone case|flower.*phone case/i, "スマートフォン用ケースです。対応機種・素材・付属品は商品バリエーションと販売元の仕様をご確認ください。"],
    [/retro.*cowhide backpack|crazy horse cowhide.*backpack/i, "レトロデザインのレディースリュックです。素材表記・寸法・収納部・ベルト仕様は販売元の最新仕様をご確認ください。"],
    [/shoes.*women.*inner height increase|inner height increase.*women.*shoes/i, "インヒール仕様のレディースシューズです。ヒール高・対応サイズ・素材・サイズ感は販売元の仕様をご確認ください。"],
    [/soft memory foam travel neck pillow|travel neck pillow.*memory foam/i, "移動中に首元を支える低反発ネックピローです。形状・素材・寸法・付属品は販売元の仕様をご確認ください。"],
    [/hooded travel pillow.*inflatable neck pillow|inflatable neck pillow/i, "旅行や移動中に使う空気注入式ネックピローです。寸法・素材・空気注入方式・付属品は販売元の仕様をご確認ください。"],
    [/square non.slip bathroom mat.*suction cup|bathroom mat.*suction cup/i, "吸盤付きの滑り止めバスマットです。対応する床面・寸法・材質・お手入れ方法は販売元の仕様をご確認ください。"],
    [/beauty salon floor towel|floor towel.*floor mat/i, "美容サロン向けのフロアタオルです。寸法・素材・厚み・洗濯方法は販売元の仕様をご確認ください。"],
    [/high.value water cup.*heat.resistant glass.*flower tea cup|heat.resistant glass flower tea cup/i, "花柄の耐熱ガラスティーカップです。容量・耐熱温度・電子レンジ対応・付属品は販売元の仕様をご確認ください。"],
    [/micro.current massager.*eye|eye.*micro.current massager/i, "目元用のマイクロカレント美顔器です。機能・給電方式・使用上の注意・付属品は販売元の仕様をご確認ください。"],
    [/eye beauty instrument home hot compress|eye patch.*pair/i, "目元用の温熱ケアパッドです。温度・使用時間・素材・使用上の注意は販売元の仕様をご確認ください。"],
    [/cosmetic jewelry rack.*three grids|cosmetic jewelry rack/i, "コスメやアクセサリーをまとめて収納するスタンドです。寸法・収納段数・素材・組み立て方法は販売元の仕様をご確認ください。"],
    [/14.inch makeup.*storage box|makeup.*portable storage box/i, "メイク用品向けの収納ケースです。外寸・内寸・仕切り・素材は販売元の仕様をご確認ください。"],
    [/crystal jade chakra combination set.*bracelet|chakra combination set.*bracelet/i, "クリスタル調デザインのブレスレットセットです。石材の種類・サイズ・セット内容は販売元の仕様をご確認ください。"],
  ];
  return rules.find(([pattern]) => pattern.test(source))?.[1] ?? null;
}
export function isSpecificJapaneseProductTitle(value: unknown): boolean {
  if (!isJapaneseProductTitle(value)) return false;
  const title = String(value).normalize("NFKC").trim();
  return !CATEGORY_ONLY_TITLES.has(title) && !/^トレンド・.+アイテム$/.test(title);
}

export function isJapaneseProductDescription(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const japanese = (value.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return japanese >= 12 && japanese >= latin * 0.5;
}

const NON_PRODUCT_TITLE_PATTERNS = [
  /商品アイデンティティ/i,
  /選定対象外/,
  /未確定/,
  /必須ゲート/,
  /テスト優先度/,
  /unknown product/i,
  /暮らしの便利アイテム/,
  /^インテリア照明$/,
  /^スマホ保護アクセサリー$/,
  /^キッチン用品$/,
  /^ペット用品$/,
  /^美容・メイクアイテム$/,
  /^ヘアケアアイテム$/,
  /^アクセサリー$/,
  /^バッグ・収納アイテム$/,
  /^トレンド・.+アイテム$/,
];

export function isJapaneseProductTitle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").trim().replace(/\\s+/g, " ");
  if (!title || NON_PRODUCT_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return false;
  const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  return japanese >= 2;
}
