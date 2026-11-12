/**
 * Pure planning for the AI live program. No network, no credentials, no
 * process control. Speech and RTMP stay in the worker or the OBS page.
 */

export type AiLiveProductCard = {
  id: string;
  title: string;
  description: string | null;
  sellingPrice: number;
  currency: string;
  inStock: boolean;
  productUrl: string;
  imageUrl?: string | null;
};

export type MixPhase = "bed" | "duck" | "restore";

export const SPEECH_DUCK_RATIO = 0.18;
export const SPEECH_DUCK_FADE_MS = 400;

const INVENTED_CLAIM = /送料無料|割引|最安|治る|効果保証|残り\d+|今だけ|世界一|絶対に/;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isIntroducibleProduct(product: AiLiveProductCard | null | undefined): product is AiLiveProductCard {
  if (!product) return false;
  if (typeof product.id !== "string" || !product.id.trim() || product.id.length > 80) return false;
  if (typeof product.title !== "string" || !product.title.trim() || product.title.length > 200) return false;
  if (product.currency !== "JPY") return false;
  if (!Number.isFinite(product.sellingPrice) || product.sellingPrice <= 0 || product.sellingPrice > 10_000_000) return false;
  if (product.inStock !== true) return false;
  if (!httpsUrl(product.productUrl)) return false;
  if (product.imageUrl != null && product.imageUrl !== "" && !httpsUrl(product.imageUrl)) return false;
  return true;
}

/** The image that belongs to this exact listing. Never reuse another product's image. */
export function productImageForDisplay(product: AiLiveProductCard | null | undefined): string | null {
  if (!isIntroducibleProduct(product)) return null;
  return httpsUrl(product.imageUrl);
}

export function scriptVariant(productId: string, rotation: number): number {
  let hash = Number.isFinite(rotation) ? Math.floor(rotation) : 0;
  for (const char of productId) hash = (Math.imul(hash, 33) + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * Builds a spoken script only from fields already on the sellable product.
 * Openings rotate so the same listing is not read identically every loop.
 */
export function buildProductScript(product: AiLiveProductCard, rotation = 0): string {
  if (!isIntroducibleProduct(product)) throw new Error("ai_live_product_not_introducible");
  const price = new Intl.NumberFormat("ja-JP").format(product.sellingPrice);
  const detail = product.description?.trim()
    ? product.description.trim().replace(/\s+/g, " ").slice(0, 280)
    : "詳しい内容は商品ページをご確認ください。";
  const variant = scriptVariant(product.id, rotation);
  const openingIndex = Math.abs(rotation) % 3;
  const closingIndex = Math.abs(rotation + variant) % 3;
  const openings = [
    `${product.title}です。`,
    `こちらは${product.title}です。`,
    `${product.title}をご紹介します。`,
  ];
  const closings = [
    `価格は${price}円です。購入ページは画面の案内から開けます。`,
    `現在の価格は${price}円です。在庫と販売条件は商品ページが最新です。`,
    `${price}円でご案内しています。色やサイズの選択肢は商品ページでご確認ください。`,
  ];
  const text = `${openings[openingIndex]}${detail}${closings[closingIndex]}`;
  if (INVENTED_CLAIM.test(text) && !INVENTED_CLAIM.test(detail)) {
    throw new Error("ai_live_script_invented_claim");
  }
  return text.slice(0, 1200);
}

export function nextIntroducibleIndex(products: AiLiveProductCard[], start: number): number | null {
  if (!Array.isArray(products) || products.length === 0) return null;
  const size = products.length;
  const origin = Number.isFinite(start) ? Math.floor(start) : 0;
  for (let step = 0; step < size; step += 1) {
    const index = ((origin + step) % size + size) % size;
    if (isIntroducibleProduct(products[index])) return index;
  }
  return null;
}

/**
 * Fades BGM toward the existing speech duck ratio and back.
 * The returned gain is never higher than the operator's base volume.
 */
export function speechMixVolume(baseVolume: number, phase: MixPhase, elapsedMs: number): number {
  const base = clamp01(baseVolume);
  const floor = base * SPEECH_DUCK_RATIO;
  const progress = smoothstep((Number.isFinite(elapsedMs) ? elapsedMs : 0) / SPEECH_DUCK_FADE_MS);
  if (phase === "bed") return base;
  if (phase === "duck") return base + (floor - base) * progress;
  return floor + (base - floor) * progress;
}

export type CommentStamp = { authorKey: string; text: string; atMs: number };

export function allowViewerComment(input: {
  text: string;
  authorKey: string;
  nowMs: number;
  recent: CommentStamp[];
}): { allow: boolean; reason: string } {
  const text = input.text.normalize("NFKC").trim();
  const authorKey = input.authorKey.trim().slice(0, 80) || "anonymous";
  if (!text || text.length > 500) return { allow: false, reason: "comment_length_rejected" };
  const windowStart = input.nowMs - 30_000;
  const fromAuthor = input.recent.filter((item) => item.authorKey === authorKey && item.atMs >= windowStart);
  if (fromAuthor.length >= 4) return { allow: false, reason: "comment_rate_limited" };
  const duplicateStart = input.nowMs - 60_000;
  const duplicates = input.recent.filter((item) => item.text === text && item.atMs >= duplicateStart);
  if (duplicates.length >= 3) return { allow: false, reason: "comment_duplicate_limited" };
  return { allow: true, reason: "comment_allowed" };
}

export type DestinationReadiness = {
  canStart: false;
  credentialsPresent: boolean;
  missing: string[];
  steps: string[];
};

export function youtubeReadiness(env: {
  clientId: boolean;
  clientSecret: boolean;
  refreshToken: boolean;
}): DestinationReadiness {
  const missing = [
    env.clientId ? "" : "YOUTUBE_CLIENT_ID",
    env.clientSecret ? "" : "YOUTUBE_CLIENT_SECRET",
    env.refreshToken ? "" : "YOUTUBE_REFRESH_TOKEN",
  ].filter(Boolean);
  return {
    canStart: false,
    credentialsPresent: missing.length === 0,
    missing,
    steps: [
      "Google Cloud で YouTube Data API v3 を有効化し、OAuth クライアントを作る。",
      "スコープは https://www.googleapis.com/auth/youtube を使う。",
      "取得したクライアント ID、クライアントシークレット、リフレッシュトークンを、ワーカー環境の YOUTUBE_CLIENT_ID、YOUTUBE_CLIENT_SECRET、YOUTUBE_REFRESH_TOKEN に入れる。ブラウザと Git には置かない。",
      "配信枠の作成後、エンコーダが streamStatus=active になるまで放送は開始しない。startBroadcast は confirmEncoderActive=true のときだけ呼ぶ。",
      "この API は認証情報が揃っていても、ここから配信開始したとは返さない。",
    ],
  };
}

export function tiktokReadiness(workerSecretPresent: boolean): DestinationReadiness {
  return {
    canStart: false,
    credentialsPresent: workerSecretPresent,
    missing: workerSecretPresent ? [] : ["TIKTOK_RTMP_URL", "TIKTOK_STREAM_KEY"],
    steps: [
      "TikTok は一般公開の配信開始 API をこのアプリに提供していない。非公式ログインやコメント取得は使わない。",
      "18歳以上で、TikTok アプリの LIVE が使えるアカウントが必要。多くの地域ではフォロワー 1,000 人以上が条件。",
      "パソコン配信用の許可は TikTok が付与する。https://livecenter.tiktok.com/producer を開く。",
      "そのページから別の画面へ戻された場合、アカウントに外部配信の許可がない。許可は TikTok の申請待ちで、このシステムからは付与できない。",
      "許可がある場合、LIVE Producer が表示する Server URL をワーカーの TIKTOK_RTMP_URL に、Stream Key を TIKTOK_STREAM_KEY に入れる。キーは数時間で無効になるので、配信の直前に作り直す。",
      "OBS または常駐ワーカーで先に映像を送り、TikTok 側が受信を表示してから LIVE Producer の Go LIVE を押す。",
      "公式のコメント取得 API は未提供のため、TikTok コメントへの自動応答は未接続のまま。",
    ],
  };
}
