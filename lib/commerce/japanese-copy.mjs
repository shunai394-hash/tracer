/**
 * Customer-facing Japanese copy based only on product attributes present in the
 * verified title. Avoid supplier-internal notes and unsupported claims.
 */
export function japaneseCommerceDescription(title) {
  const value = String(title ?? "").trim();
  if (!value) return "";
  if (value.includes("日光で色が変わるアセテート製シャーククリップ")) {
    return "日光で色の変化を楽しめるアセテート製のシャーククリップ。まとめ髪のアクセントに使えるヘアアクセサリーです。光の強さや環境によって色の見え方は異なります。";
  }
  if (value.includes("メタルバックル付きラウンドバッグ")) {
    return "丸みのあるシルエットにメタルバックルをあしらったラウンドバッグ。普段のお出かけやコーディネートのアクセントに取り入れやすいデザインです。サイズや収納仕様は商品画像・仕様欄をご確認ください。";
  }
  if (value.includes("レディースハンドバッグ") || value.includes("ラウンドハンドバッグ")) {
    return "毎日の外出やお出かけに合わせやすいレディースハンドバッグ。カラーや形状は商品画像でご確認ください。サイズ・収納量は仕様欄をご確認ください。";
  }
  if (value.includes("メイク用ファンブラシ")) {
    return "ファン型のメイクブラシ。メイクの仕上げやパウダーを整える際に使いやすい形状です。ご使用後は清潔に保ち、肌に合わない場合は使用を中止してください。";
  }
  if (value.includes("PUレザー調ヘッドバンド付きポニーテールクリップ")) {
    return "PUレザー調のヘッドバンドとポニーテールクリップを組み合わせたヘアアクセサリー。まとめ髪やポニーテールのアレンジに取り入れやすいデザインです。";
  }
  if (value.includes("レディース ヘアゴム・ヘアロープ")) {
    return "髪をまとめるヘアゴム・ヘアロープ。普段のまとめ髪やヘアアレンジにお使いいただけます。";
  }
  if (value.includes("コスプレ用ヘアアクセサリー")) {
    return "コスプレやイベントのヘアアレンジに合わせやすいアクセサリー。衣装やスタイルに合わせてご使用ください。";
  }
  if (value.includes("ヘアアクセサリー") || value.includes("ヘアクリップ") || value.includes("ヘアバンド")) {
    return "日常のヘアアレンジのアクセントに使えるヘアアクセサリー。形状やカラーは商品画像・仕様欄をご確認ください。";
  }
  if (value.includes("メイクブラシ") || value.includes("美容ツール")) {
    return "毎日のメイクに使う美容ツール。使用方法やお手入れ方法は商品仕様をご確認のうえ、清潔に保ってご使用ください。";
  }
  if (value.includes("スマートフォンケース")) {
    return "スマートフォン用のケース。対応機種や装着時の仕様は商品画像・仕様欄をご確認ください。";
  }
  if (value.includes("ペット")) {
    return "ペットとの日常に使うアイテム。対応するペットの種類やサイズは商品仕様をご確認ください。";
  }
  if (value.includes("キッチン収納")) {
    return "キッチンまわりの整理整頓に使う収納アイテム。設置場所やサイズは商品仕様をご確認ください。";
  }
  if (value.includes("旅行用収納ポーチ")) {
    return "旅行時の小物や荷物の整理に使う収納ポーチ。収納量やサイズは商品画像・仕様欄をご確認ください。";
  }
  if (value.includes("アクセサリー")) {
    return "コーディネートのアクセントに使えるアクセサリー。形状やカラーは商品画像・仕様欄をご確認ください。";
  }
  return `${value}。日常に取り入れやすいアイテムです。サイズ・素材・仕様は商品画像と商品情報をご確認ください。`;
}
