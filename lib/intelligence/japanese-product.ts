const SPECIFIC_TITLE_RULES: Array<[RegExp, string]> = [
  [/a4\\s+portable\\s+printers?|thermal printer.*phomemo|phomemo.*thermal printer/i, "A4対応 ポータブル感熱プリンター"],
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
  [/creative new envelopes diagonally across/i, "商品仕様の再確認が必要なスマホアクセサリー"],
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
  const source = value.normalize("NFKC").trim().replace(/\\s+/g, " ");
  if (!source) return null;

  // Specific, source-grounded product names must win over broad category rules.
  const specific = SPECIFIC_TITLE_RULES.find(([pattern]) => pattern.test(source));
  if (specific) return specific[1];

  let title = source;
  for (const [pattern, replacement] of TITLE_REPLACEMENTS) title = title.replace(pattern, replacement);
  title = title.replace(/\\s*[-|•]+\\s*/g, "・").replace(/\\s{2,}/g, " ").trim();
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
    [/a4\\s+portable\\s+printers?|thermal printer.*phomemo|phomemo.*thermal printer/i, "A4サイズの用紙に対応する携帯型感熱プリンターです。対応用紙・接続方式・付属品は販売元の仕様をご確認ください。"],
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
    [/three-dimensional piggy butt.*phone case|piggy butt phone case|flowers.*phone case|flower.*phone case|creative new envelopes diagonally across/i, "スマートフォン用ケースです。対応機種・素材・付属品は商品バリエーションと販売元の仕様をご確認ください。"],
  ];
  return rules.find(([pattern]) => pattern.test(source))?.[1] ?? null;
}
export function isJapaneseProductTitle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").trim();
  if (!title) return false;
  const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  return japanese >= 2;
}
