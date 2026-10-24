import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";
import { isSpecificJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "../lib/intelligence/japanese-product.ts";
import { womenProductPriority } from "../lib/intelligence/womens-priority.ts";

const cases = [
  ["ordinary Japanese product title", "折りたたみ収納ボックス", true],
  ["generic category-only bathroom title", "バスルームマット", false],
  ["generic category-only kitchen title", "キッチン用品", false],
  ["generic handbag title", "レディース ハンドバッグ", false],
  ["generic shoulder bag title", "レディース ショルダーバッグ", false],
  ["generic hair clip title", "ヘアクリップ", false],
  ["generic makeup brush title", "メイクブラシ", false],
  ["specific handbag title", "レトロデザイン ヴィーガンレザーショルダーバッグ", true],
  ["specific hair accessory title", "ハート・星モチーフ メタルヘアクリップ", true],
  ["specific makeup brush title", "木製ハンドル メイクブラシセット", true],
  ["descriptive bathroom mat title", "吸盤付き ノンスリップ バスマット", true],
  ["descriptive kitchen product title", "キッチン用品 収納ラック", true],
  ["identity failure suffix", "暮らしの便利アイテム 商品アイデンティティが未確定のため、選定対象外", false],
  ["sales gate failure suffix", "ペット用品 必須ゲートを満たしていないため、テスト優先度は低い", false],
  ["truncated evidence suffix", "スマホケース は観測された需要と供給データに基", false],
  ["sales candidate explanation suffix", "マスカラ 防水 Super Long は観測された需要と供給データに基づいて販売テスト候補になる", false],
  ["placeholder trend title", "トレンド・seeded_dueアイテム", false],
  ["generic specification placeholder", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。", false],
  ["empty title", "", false],
  ["non-string title", null, false],
  ["overlong title", "a".repeat(181), false],
  ["description placeholder", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。", false],
  ["description placeholder with shipping suffix", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。 日本向け配送：送料別。", false],
  ["specific product description", "収納ボックス。折りたたみ式で、使わない時は薄く収納できます。", true],
  ["empty description", "", false],
];
for (const [name, title, expected] of cases) {
  if (name.includes("description")) {
    assert.equal(isPublishableCatalogDescription(title), expected, name);
  } else {
    assert.equal(isPublishableCatalogTitle(title), expected, name);
  }
}

assert.equal(localizeProductTitle("Simple Oil Wax Leather Messenger Shoulder Bags Women's High Capacity Portable Tote Bag"), "レディース ショルダーバッグ");
assert.equal(localizeProductTitle("Portable Cosmetic Bag Waterproof Divider Multi-grid Pockets Toiletry Bags Travel Storage Handbags Women Make Up Bag"), "仕切り付き コスメポーチ");
assert.equal(localizeProductTitle("Facial Spot Scanning Machine Mini Home Mole Spotting Apparatus"), "家庭用 フェイススポットケア機器");
assert.equal(localizeProductTitle("Fashion And Nature Phoera Eyebrow Cream 6 Colors (Fashion And Nature Phoera Eyebrow Cream 6 Colors 01Blonde)"), "PHOERA アイブロウクリーム 01 ブロンド");
assert.equal(localizeProductTitle("Ceramic Ashtray Home Bedroom Dormitory Office"), "セラミック製 卓上灰皿");
assert.equal(localizeProductTitle("BathroomMobile Phone Box WaterproofStand Toilet Storage Artifact Toilet Bath Rack Kitchen Chase Drama Watching TV"), "防水ケース付き バスルーム用スマホホルダー");
assert.equal(localizeProductTitle("Suitable For Creative New Envelopes Diagonally Across Huawei P40pro Mobile Phone Shell Mate30 Acrylic Nova5 Protective Sleeve"), "Huawei対応 アクリルスマホケース");
assert.equal(localizeProductTitle("Compatible WithApple, Suitable ForApple 12 Tempered Glass FilmIPhone11ProMax Full Screen Coverage Xs Mobile Phone Film 7,8Plus"), "iPhone用 強化ガラス保護フィルム");
assert.equal(localizeProductTitle("Comma Facial Brush Soft Hair Face Cleaning Facial Cleansing Massage Brush (Comma Facial Brush Soft Hair Face Cleaning Facial Cleansing Massage Brush Bamboo charcoal protrusions)"), "竹炭突起付き フェイス洗顔ブラシ");
assert.equal(localizeProductTitle("Simple Retro Small Handbag Women (Simple Retro Small Handbag Women Wine Red)"), "レトロデザイン レディースミニハンドバッグ");
assert.equal(localizeProductTitle("Harajuku Canvas Bags Students Handbag With Pockets Preppy Buckpack Shoulder Bag For Women Shoolbags Black"), "ポケット付き キャンバスリュック レディース");
assert.equal(localizeProductTitle("Portable Transparent Shoulder Crossbody Bag Tote Satchel Handbag For Women (Portable Transparent Shoulder Crossbody Bag Tote Satchel Handbag For Women Black)"), "クリア素材 レディースショルダーバッグ");
assert.equal(localizeProductTitle("Crossbody Bag Vegan Leather Women Retro Small Saddle Satchel Shoulder Bag With Long Adjustable Strap (Crossbody Bag Vegan Leather Women Retro Small Saddle Satchel Shoulder Bag With Long Adjustable Strap Black)"), "レトロデザイン ヴィーガンレザーショルダーバッグ");
assert.equal(localizeProductTitle("Summer Woven Hollowed Handbag For Women"), "透かし編み サマーハンドバッグ");
assert.equal(localizeProductTitle("New Large Capacity Laptop Handbag (New Large Capacity Laptop Handbag Black 12inch)"), "大容量 ノートPC収納対応 レディースハンドバッグ");
assert.equal(localizeProductTitle("Portable Plush Handbag For Women"), "ぬいぐるみ風素材 レディースハンドバッグ");
assert.equal(localizeProductTitle("Fashion Woven Handbag For Women"), "編み込みデザイン レディースハンドバッグ");
assert.equal(localizeProductTitle("Women Patent Leather Flower Handbag"), "花モチーフ エナメル調ハンドバッグ");
assert.equal(localizeProductTitle("Woven Hanging Handbag Women Embroidery Fashion"), "刺繍入り 編み込みハンドバッグ");
assert.equal(localizeProductTitle("Large Capacity Suede Handbag For Women"), "スエード調 大容量ハンドバッグ");
assert.equal(localizeProductTitle("Retro Textured Shoulder Bag Women Underarm"), "レトロ型押し アンダーアームバッグ");
assert.equal(localizeProductTitle("Single Shoulder Messenger Tote Bag Women"), "ワンショルダー メッセンジャートート");
assert.equal(localizeProductTitle("Retro Matte Shoulder Bag For Women"), "マット調 レトロショルダーバッグ");
assert.equal(localizeProductTitle("Children's Hair Ornaments Cartoon Fruit Hair Clips Women's Colorful Quicksand"), "フルーツ柄 カラフルヘアクリップ");
assert.equal(localizeProductTitle("Love Handmade Bow Hair Clips Accessories"), "リボンモチーフ ヘアクリップ");
assert.equal(localizeProductTitle("Electric Brush Cleaner Makeup Brush Tool For Automatic Cleaning"), "電動メイクブラシクリーナー");
assert.equal(localizeProductTitle("Women's Pure Cotton Handbag"), "コットン素材 レディースハンドバッグ");
assert.equal(localizeProductTitle("Zero Makeup Brush Suit Internet Hot Beauty Makeup Tools"), "メイクブラシセット");
assert.equal(localizeProductTitle("Shoulder Bag Women Pattern Handbag"), "柄デザイン レディースショルダーバッグ");
for (const title of ["バッグ・収納アイテム", "美容・メイクアイテム"]) {
  assert.equal(isSpecificJapaneseProductTitle(title), false, title);
}
for (const title of ["レディース ハンドバッグ", "レディース ショルダーバッグ", "ヘアクリップ", "メイクブラシ"]) {
  assert.equal(isSpecificJapaneseProductTitle(title), false, title);
}
assert.equal(localizeProductTitle("6 Pack Headbands For Women, Boho Wide Head Bands Hair Accessories"), "ボヘミアン風 幅広ヘアバンド 6本セット");
assert.equal(localizeProductTitle("PU Leather Headband Gel Women Ponytail Clip Decoration Hair Accessories"), "レザー調ヘッドバンド付きポニーテールクリップ");
assert.equal(localizeProductTitle("Unrecognized Supplier Model 4839", "women handbag"), null, "do not fabricate a title from the search query");
assert.equal(localizeProductTitle("", "beauty tools"), null, "do not fabricate a title when supplier title is missing");
assert.equal(localizeProductTitle("Halloween Shark Claw Clip - Ghost Pumpkin Black Cat Print Hair Accessory for Women Girls Party Cosplay (Halloween Shark Claw Clip - Ghost Pumpkin Black Cat Print Hair Accessory for Women Girls Party Cosplay D9)"), "おばけ・かぼちゃ柄 シャーク型ヘアクリップ");
for (const title of ["竹炭突起付き フェイス洗顔ブラシ", "レトロデザイン レディースミニハンドバッグ", "ポケット付き キャンバスリュック レディース"]) {
  assert.equal(isPublishableCatalogTitle(title), true, title);
}
for (const source of [
  "Ceramic Ashtray Home Bedroom Dormitory Office",
  "BathroomMobile Phone Box WaterproofStand Toilet Storage Artifact Toilet Bath Rack Kitchen Chase Drama Watching TV",
  "Suitable For Creative New Envelopes Diagonally Across Huawei P40pro Mobile Phone Shell Mate30 Acrylic Nova5 Protective Sleeve",
  "Compatible WithApple, Suitable ForApple 12 Tempered Glass FilmIPhone11ProMax Full Screen Coverage Xs Mobile Phone Film 7,8Plus",
]) {
  assert.equal(isPublishableCatalogTitle(localizeProductTitle(source)), true, source);
  assert.equal(isPublishableCatalogDescription(localizeProductDescription(source)), true, source);
}
assert.equal(localizeProductTitle("Bohemian Beach Vacation Flower Hair Clip For Women Fashion Girl Accessories Gift"), "フラワーモチーフ ヘアクリップ");
assert.equal(localizeProductTitle("Groin Electric Clippers Household Hair Clipper (Groin Electric Clippers Household Hair Clipper Black Cutter head)"), "デリケートゾーン用 電動トリマー");
assert.equal(localizeProductTitle("Art Design Graffiti Art Hip Hop African Girl with Black Hair Big Earring with Modern Building Shower Curtain for Bathroom Decor"), "アフリカンアート柄 シャワーカーテン");
const cjHairTitleCases = [
  ["Cellulose Acetate Sheet Hair Accessories Plaid Headband For Women", "セルロースアセテート チェック柄ヘアバンド"],
  ["Cute Girly Knitted Wool Headband Hair Accessories Women", "レディース ニットウール ヘアバンド"],
  ["Women Hollow Hair Circle High Horsetail Artifact Fixed Coiler Hairpin Horsetail Headdress Fashion Hair Accessories", "ポニーテール用 ホローデザイン ヘアアクセサリー"],
];
for (const [source, expected] of cjHairTitleCases) {
  const localized = localizeProductTitle(source);
  assert.equal(localized, expected, source);
  assert.equal(isPublishableCatalogTitle(localized), true, `localized title must pass publication gate: ${source}`);
}
const nativeHeadbandSource = "Acrylic Thick Wool Knitted Headband Diagonally Crossed Hair Accessories For Women";
const nativeHeadbandTitle = localizeProductTitle(nativeHeadbandSource);
assert.equal(nativeHeadbandTitle, "ニット編み クロスヘアバンド");
assert.equal(isPublishableCatalogTitle(nativeHeadbandTitle), true, "verified native CJ product must have a concrete Japanese title");
assert.equal(isPublishableCatalogDescription(localizeProductDescription(nativeHeadbandSource)), true, "verified native CJ product must have a specific Japanese description");
assert.equal(womenProductPriority({ title: nativeHeadbandSource }).isWomenFocused, true);
assert.equal(isPublishableCatalogTitle("トレンド・beautyアイテム"), false);
assert.equal(localizeProductTitle("Self-Care Journal Gift Set (Suit Beige XINGX)"), "セルフケアノート ギフトセット");
assert.equal(localizeProductTitle("Creative Trend Linen Plan New Self-care Notebook (Notebook Beige)"), "リネン調 セルフケアノート");
assert.equal(isPublishableCatalogTitle(localizeProductTitle("Self-Care Journal Gift Set (Suit Beige XINGX)")), true);
assert.equal(isPublishableCatalogTitle(localizeProductTitle("Creative Trend Linen Plan New Self-care Notebook (Notebook Beige)")), true);
assert.equal(isPublishableCatalogTitle("アフリカンアート柄 シャワーカーテン"), true);
const candidateTitles = [
  ["aroma diffuser", "50ml Aromatherapy Machine Timed Automatic Spraying Fragrance Household Perfume Machine Toilet Deodorizing Air Purifying Diffuser", "タイマー付き 自動噴霧アロマディフューザー"],
  ["resort skirt", "Sun Protection Clothing Beach Seaside Resort Strappy Skirt", "リゾートデザイン ストラップスカート"],
  ["filtered shower head", "Beauty Dechlorinating Dual Filter Shower Head (Beauty Dechlorinating Dual Filter Shower Head Kdf Filter Element)", "二重フィルター付き シャワーヘッド"],
  ["leather backpack", "Retro First Layer Cowhide Backpack Crazy Horse Cowhide Ladies Small Backpack", "レトロデザイン レザー調レディースリュック"],
  ["inner height shoes", "Shoes Women's Inner Height Increase Women's Shoes", "インヒール レディースシューズ"],
  ["memory foam neck pillow", "Soft Memory Foam Travel Neck Pillow U Shape Adjustable Support Comfortably Sleeping On Plane Car Office Noon Break", "低反発 トラベルネックピロー"],
  ["non-slip bathroom mat", "Square Non-slip Bathroom Mat With Suction Cup And Round Hole Design Shower Anti-fall Household Shower Massage Quick Drainage Mat", "吸盤付き 滑り止めバスマット"],
  ["beauty salon towel", "White Beauty Salon Floor Towel Flat Woven Hotel Floor Mat", "美容サロン用 フロアタオル"],
  ["heat resistant tea cup", "High-value Water Cup Female Cute Heat-resistant Glass Flower Tea Cup Home Ins Style Office Drinking Cup With Lid Spoon", "花柄 耐熱ガラスティーカップ"],
  ["microcurrent eye device", "The New Beauty Eye Micro-current Massager Color Light Iontophoresis Instrument", "目元用 マイクロカレント美顔器"],
  ["eye care pad", "Eye Beauty Instrument Home Hot Compress (Eye patch A pair)", "目元用 温熱ケアパッド"],
  ["cosmetic jewelry rack", "Cosmetic jewelry rack (Cosmetic jewelry rack Three grids)", "コスメ・アクセサリー収納スタンド"],
  ["makeup storage case", "14-inch Makeup Ultra-light Hard Case Portable Storage Box", "14インチ対応 メイク収納ケース"],
  ["crystal bracelet set", "Crystal Jade Chakra Combination Set Love Hexagon Pillar Bracelet", "クリスタル調デザイン ブレスレットセット"],
  ["aroma filter", "Aroma Filter", "アロマ用 交換フィルター"],
  ["card case phone shell", "Compatible with Apple Cross Border Suitable For Iphone12 Integrated Frosted Card Case Mobile Phone Shell", "カード収納付き スマートフォンケース"],
  ["lotus mug", "Hand Painted Lotus Office Mug (Hand Painted Lotus Office Mug Water Cup)", "蓮柄 手描きマグカップ"],
  ["antique desk lamp", "Bedside Antique Desk BZ69 Small Table Lamp In Bedroom", "アンティーク調 ベッドサイドランプ"],
  ["grease nipple set", "Boxed Straight Bend Grease Nipple Universal Lubrication Set", "グリースニップル 潤滑用部品セット"],
  ["crochet sunflower ornament", "Handmade Crochet Sunflower Potted Ornament With Green Leaves For Birthday Gift Home Office Desk Decor", "かぎ針編み ひまわり鉢植えオーナメント"],
  ["locked mermaid notebook", "Cartoon Fishtail Pearl Plush Children's Cute Notebook With Lock", "人魚モチーフ 鍵付きノート"],
  ["rainbow crystal ornament", "Natural Rainbow Chakra Crystal Raw Stone", "虹色クリスタル 原石風オーナメント"],
  ["face line training tool", "Masseter Lower Jaw Line Exercise Face Slimming", "フェイスライン用 トレーニング器具"],
  ["waterproof bathroom phone holder", "Shower Phone Box Bathroom Waterproof Phone Case Seal Protection Touch Screen Mobile Phone Holder For Kitchen Handsfree Gadget", "防水 スマートフォン用バスルームホルダー"],
  ["color hair ties", "Rubber Bands 15mm 250 Count Colored Elastic Hair Ties For Braids", "カラーヘアゴム 250本セット"],
  ["corduroy chair cushion", "Winter thickened office corduroy chair cushion", "コーデュロイ調 チェアクッション"],
  ["peacock wind chime", "Wind Chimes Peacock Feather Luminous Beads Wall Pendant Creative Dream Catcher", "孔雀羽根風 ウィンドチャイム壁飾り"],
  ["ankle support belt", "PU Leather Adjustable Ankle Brace Buckle Hip Leg Pull Training", "調節式 アンクルサポートベルト"],
  ["rechargeable drill", "Lithium Electric Rechargeable Drill Portable Multi Function", "充電式 多機能電動ドリル"],
  ["pillowcase", "Living Room Office Car Pillowcase Gift", "リビング・車内用 ピローケース"],
  ["cotton bath towel set", "Bath Towel Suit Pure Cotton Home Bath Gray 6PCS", "綿素材 バスタオル 6枚セット"],
  ["arowana cup", "Hand Painted Arowana Master Cup Ceramic Household Tea Cup", "手描き アロワナ柄 セラミックティーカップ"],
  ["bathroom set", "Bathroom Five-piece Set, Shower Curtain, Three-piece Mat Set, Aluminum Alloy Decorative Painting", "シャワーカーテン・マット 5点セット"],
  ["marble phone case", "Applicable To S9 Laser Marble IMD Soft Shell All-inclusive S8Plus Creative Fashion Mobile Phone Shell Note9", "大理石調 スマートフォンケース"],
  ["crystal pyramid ornament", "Strengthen wealth help tower business natural crystal 4-5cm energy Orgone pyramid decoration craft resin gift", "クリスタル調 ピラミッド型インテリア置物"],
  ["wire organizer clip", "Multifunctional Clip Holder Thumb Hooks Wire Organizer Wall Hooks Hanger Strong Wall Storage Holder For Kitchen Bathroom", "多機能 ケーブル・小物用クリップホルダー"],
  ["electric bath brush", "Electric Bath Scrubber, Shower Brush, Bathing Back-scrubbing Magic Tool, Long-handled Automatic Bath Brush", "電動 ロングハンドルバスブラシ"],
  ["floor cushion", "Cushion, Futon, Lazy Cushion, Floor, Office, Soft Japanese Style", "和風 フロアクッション"],
  ["travel clothes bag", "Washing suit bag travel bag men's travel storage does not include toiletries", "旅行用 衣類収納バッグ"],
  ["lotus vase DIY kit", "Diy Handmade Creative Weaving Twisted Stick Lotus Vase Homemade Material Bag Suit", "DIY 蓮の花 編み込み花瓶キット"],
  ["large storage bin", "Home Automatic Creative Cute Good-looking Large Capacity Storage Bin", "大容量 自動収納ボックス"],
  ["bath salt", "Essential Oil Bath Himalayan Bath Salt", "エッセンシャルオイル入り バスソルト"],
  ["mirror alarm clock", "Simple Cloud Mirror Clock Intelligent Voice-controlled Induction Alarm Clock", "音声操作対応 ミラー型アラームクロック"],
  ["long raincoat", "Polka Dot Raincoat Long Thickened Walking Tour", "水玉柄 ロングレインコート"],
  ["self-cleaning hair brush", "Air Cushion Comb Automatic Cleaning Of Broken Hair Portable", "自動クリーニング エアクッションブラシ"],
  ["glass rooster ornament", "Creative Colorful Glass Rooster Decoration Glass Chicken Desk TV Cabinet Hallway Home Desktop Decorative Crafts", "カラフル ガラス製ニワトリ置物"],
  ["flame diffuser", "New Flame Aromatherapy Machine Colorful Essential Oil Diffuser Home Large Fog Volume Flame Humidifier 3D Flame Fireplace Machine", "炎型 アロマディフューザー"],
  ["no-drill towel rack", "Gun Gray Towel Rack Bathroom Punch-free Bathroom Rack", "穴あけ不要 タオルラック"],
  ["panda desk ornament", "Creative Cute Panda Ornaments Office Desk Surface Panel", "パンダモチーフ デスクオーナメント"],
  ["foldable wireless charger", "Three-in-one Wireless Charger Electrical Foldable Double Wire Ambience Light Mobile Phone Wireless Charger", "3in1 折りたたみワイヤレス充電器"],
  ["rabbit blanket", "Double-sided Rabbit Plush Blanket Home Nap Office Blanket", "うさぎモチーフ 両面フランネルブランケット"],
  ["desk fan", "Office 8-inch Wind-driven Fan", "卓上 8インチ送風ファン"],
  ["cup warmer", "Cup Warmer Pad USB Charge Home Office 3 Temperatures Adjustable Heat Plate LED Display Electric Heater Mug Pad Winter Kitchen Gadgets", "USB給電 カップウォーマー 3段階温度調節"],
  ["diamond grinding head", "Diamond Grinding Head Electric Grinding Accessories Sheet", "ダイヤモンド研磨ヘッド 工具用アクセサリー"],
  ["coffee wall sticker", "Cup Coffee Removable Wall Sticker Decorative Painting", "コーヒーカップ柄 貼ってはがせるウォールステッカー"],
  ["invitation card", "Sulfuric Acid Paper Invitation Card Bronzing Matte Varnish", "硫酸紙 箔押し招待状カード"],
  ["hearing aid dryer", "Electric USB UV Drying Box Headphone Dehumidifier Moisture Proof Hearing Aid UV Dryer Case", "USB給電 補聴器・イヤホン乾燥ケース"],
  ["interior art", "Home Decor Living Room Art Art Girl", "人物モチーフ インテリアアート"],
  ["type-c cable", "Rogue Dog Data Cable Type C For Android Sport Dog Mobile Puppy Data Cable Phone Charging Cable", "犬モチーフ Type-C 充電ケーブル"],
  ["agave ornament", "New Cross-Border Iron Art Agave Plant Ornaments Agave Garden Ornaments", "アガベ風 アイアンガーデンオーナメント"],
  ["sports car phone case", "Compatible with Apple , Creative Sports Car Anti-Fall Mobile Phone Case For Protective Cover Silicone Soft Shell Trendy", "スポーツカー柄 耐衝撃スマートフォンケース"],
  ["generic phone case", "Compatible With Apple Mobile Phone Case For iPhone 13", "対応機種別 スマートフォンケース"],
  ["tongue scraper", "Stainless Steel Tongue Scraper", "ステンレス製 舌クリーナー"],
  ["sea lion pillowcase", "Plush Hug Pillowcase Cushion Office Sea Lion Velvet Pillowcase Amazon Home Custom Gift Cushion Cover", "アシカ柄 ベルベット調クッションカバー"],
  ["bread baking mold", "Bread Baking Molds For Baking", "パン作り用 ベーキングモールド"],
  ["mini office safe", "Mini office safe", "小型 オフィス用金庫"],
  ["pink heart wall sticker", "Girly Heart Pink Watercolor Plant Flowers Baby Room Dormitory Bedroom Decoration Wall Stickers", "ピンクのハート柄 ウォールステッカー"],
  ["living room wall sticker", "Wall Stickers Living Room Wall Decoration Creative TV Background Bedroom Self Adhesive Paper", "リビング向け 壁面デコレーションシール"],
  ["soft toothbrush", "Micron Soft Toothbrush", "Micron ソフト歯ブラシ"],
  ["holiday door frame", "Wooden Door I Saw That Jesus Head Funny Home Decor Frame Ornament AND Merry Christmas Door Frame Decoration Santa Claus Elk", "クリスマス ドアフレーム飾り"],

  ["chair cushion", "Sedentary Backrest Integrated Chair Cushion Seat Cushion", "背もたれ一体型 チェアクッション"],
  ["nordic sofa cushion", "Nordic Pillows Cushions Home Decor Pillows Decorative Living Room Office Cushion Decorative Cushions For Sofa", "北欧風 ソファクッション"],
  ["silicone drain catcher", "Sink Drain Strainer Hair Catchers Rubber Shower Bathtub Floor Filter Water Stopper Silicone Bathroom Kitchen Deodorant Plug", "排水口用 シリコンヘアキャッチャー"],
  ["highlighter set", "25 Colors Double Head Highlighter Pen Mildliner Colors Fluorescent Highlighters Art Marker School Office", "両頭蛍光マーカー 25色セット"],
  ["waterproof mouse pad", "Competitive Gaming Office Waterproof Mouse Pad", "防水 ゲーミングマウスパッド"],
  ["foot hammock", "Office Leg And Foot Hammock Long-Distance Travel Foot Fatigue Relief Tool Airplane Travel Foot Hammock", "オフィス・旅行用 フットレストハンモック"],
  ["electric kitchen scrubber", "Kitchen Supplies Multifunctional Brush Electric Scrubber Rechargeable Dishwashing Brush Automatic Range Hood Stove", "充電式 電動キッチンクリーナー"],
  ["nylon grinding wheel", "T-type Fiber Grinding Head Nylon Wheel Grinding Disc", "T型 ナイロン研磨ホイール"],
  ["insulated lunch tote", "Soft Lightweight Insulated Office Lunch Tote", "保冷ランチトートバッグ"],
  ["laundry set", "Laundry &cleansing Set", "ランドリー・洗濯用品セット"],
  ["rice storage container", "Rice Bucket Automatic Out Household Food Grade Insect Proof", "防虫仕様 米びつ保存容器"],
  ["compact humidifier", "Household Capacity Mute Mini Office Humidification", "静音 コンパクト加湿器"],
  ["six-color eyebrow cream", "Fashion And Nature Phoera Eyebrow Cream 6 Colors", "PHOERA アイブロウクリーム 6色展開"],
  ["keratin hair treatment cream", "PHOFAY POLY KERATIN BURNT HAIR RESTORATION CREAM", "ケラチン配合 ヘアトリートメントクリーム"],
  ["bath bomb gift set", "Bath Bombs 14 Pieces Of Explosive Salt Ball Gift Box With Various Fragrance Bath Balls Bubble Bath Bomb for Women", "バスボム 14個セット"],
];
for (const [name, source, expected] of candidateTitles) {
  const title = localizeProductTitle(source);
  assert.equal(title, expected, name + " must produce a concrete Japanese title");
  assert.equal(isPublishableCatalogTitle(title), true, name + " title must pass storefront quality gate");
  assert.equal(isPublishableCatalogDescription(localizeProductDescription(source)), true, name + " description must pass storefront quality gate");
}
assert.equal(womenProductPriority({ title: "Groin Electric Clippers Household Hair Clipper" }).isWomenFocused, false, "hair clipper must not match the hair-clip accessory category");
assert.equal(womenProductPriority({ title: "Flower Hair Clip Accessory" }).isWomenFocused, true, "actual hair-clip accessories remain women-focused");
const supplySelector = await readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.match(supplySelector, /isPublishableCatalogTitle\(localizedTitle\)/, "supply publication must enforce buyer-facing title quality");
assert.match(supplySelector, /if \(!isPublishableCatalogTitle\(title\)\)/, "final listing write must reject generic fallback titles");
assert.match(supplySelector, /if \(!isPublishableCatalogDescription\(item\.description\)\)/, "final listing write must reject unusable descriptions");
assert.doesNotMatch(supplySelector, /\?\? String\(item\.base\.normalized_title \?\? \("TRACER product "/, "generic generated title fallback must not bypass title validation");
assert.match(localizeProductDescription("Bohemian Beach Vacation Flower Hair Clip For Women"), /花モチーフのヘアクリップ/);
 
const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(shopify, /isPublishableCatalogTitle\(row\.title\)/, "Shopify sync must enforce publishable title guard");
assert.match(shopify, /catalog_title_not_publishable/, "Shopify sync must report title block reason");
assert.match(shopify, /isPublishableCatalogDescription\(row\.description\)/, "Shopify sync must reject generic descriptions");
assert.match(shopify, /workflowDescription = \/商品アイデンティティが未確定/, "Shopify sync must repair persisted workflow-status descriptions");
assert.match(shopify, /staleWorkflowCopy/, "Shopify reconciliation must resync existing products with stale workflow copy");
assert.match(shopify, /仕入先の送料見積もりは商品価格の計算に反映しています/, "Shopify copy must not claim nonzero supplier shipping is separately charged");
assert.doesNotMatch(shopify, /送料別（仕入先条件に従います）/, "Shopify copy must not label shipping separately when supplier shipping is priced into the listing");
assert.match(base, /isPublishableCatalogTitle\(sourceTitle\)/, "BASE must reject invalid source titles");
assert.match(base, /isPublishableCatalogTitle\(translatedTitle\)/, "BASE must reject invalid translated titles");
assert.match(base, /isPublishableCatalogDescription\(sourceDetail\)/, "BASE must reject generic source descriptions");
assert.match(base, /isPublishableCatalogDescription\(translatedDetail\)/, "BASE must reject generic translated descriptions");
assert.match(base, /base_hide_failed_after_catalog_validation/, "BASE hide failure must be surfaced");
assert.doesNotMatch(base, /title: "販売停止中の商品"/, "BASE reconciliation must never replace the buyer-facing product title with a workflow status");
assert.match(base, /title: String\(listing\.title \?\? ""\)\.trim\(\) \|\| "商品情報確認中"/, "BASE reconciliation must preserve the existing title when a listing is hidden");
assert.match(base, /const activeListings = publishableListings\.filter\(\(listing\) => !identityUnlinkedIds\.has\(String\(listing\.id\)\)\)/, "BASE must retry freshly verified supplier-linked hidden rows instead of permanently excluding them");
assert.match(store, /isPublishableCatalogTitle\(listing\.title\)/, "storefront must filter invalid titles");
assert.match(store, /isPublishableCatalogDescription\(listing\.description\)/, "storefront must filter generic descriptions");
assert.match(store, /listing title failed catalog quality gate/, "order placement must revalidate title quality");

for (const [source, expected] of [
  ["One Word Clip Frog Buckle Pearl Full Diamond Hair Accessories Women", "パール装飾 カエルモチーフ ヘアクリップ"],
  ["Combination Suit Women Side Clip Hair Accessories", "レディース サイドヘアクリップ セット"],
  ["Sponge Hair Band Women Gold Velvet Diamond Accessories", "ゴールド装飾 ベルベットヘアバンド"],
  ["Women's Hair Chain Wave Fashion Headdress Hair Accessories Women", "ウェーブデザイン ヘアチェーン"],
  ["Women S Broad Brim Sports Headband Headband Jewelry Hair Accessories", "幅広スポーツヘッドバンド レディース"],
  ["Rhinestone Hair Accessories Alloy Headband For Women", "ラインストーン装飾 メタルカチューシャ"],
  ["Girl's Colorful Hair Band Handmade Crochet Fashion Color Contrast Hair Accessories Cotton Braided Ear Warmer Wear Matching Headband For Women", "手編み風 カラフルヘアバンド"],
  ["Diamond-embedded Large Intestine Hair Ring Hair Accessories Women", "ラインストーン装飾 ヘアリング"],
  ["Women's Fashion Hairpin Hairpin Hair Accessories Women", "レディース ファッションヘアピン"],
  ["Vintage Hair Accessories Headband For Women", "ヴィンテージデザイン ヘッドバンド"],
  ["Niche Design Flame Irregular Hair Accessories Women", "フレームデザイン ヘアアクセサリー"],
]) {
  assert.equal(localizeProductTitle(source), expected, `audited CJ title must localize specifically: ${source}`);
}

console.log(`Catalog title/description quality tests: ${cases.length} cases + 20 channel wiring/title-quality checks passed.`);
