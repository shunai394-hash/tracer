export type MuseAttachmentKinds = {
  image?: boolean;
  voice?: boolean;
  bgm?: boolean;
  lipsync?: boolean;
};

export type MuseVideoPlan = {
  ready: boolean;
  missing: string[];
  question: string;
  manifest: Record<string, unknown> | null;
  assetPaths: string[];
};

const VIDEO_REQUEST = /動画を作|動画にして|動画制作|口パク|商品紹介動画|ドラマにして|この台本|この画像を使って/;

type SceneDraft = {
  title: string;
  text: string;
  durationSeconds: number;
};

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(60, Math.max(0.5, Math.round(value * 10) / 10));
}

function requestedDuration(message: string): number | null {
  const match = message.match(/(\d+(?:\.\d+)?)\s*秒/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.min(900, Math.max(0.5, value));
}

function requestedAspect(message: string): "16:9" | "9:16" | "1:1" {
  if (/9\s*:\s*16|縦型|縦画面/.test(message)) return "9:16";
  if (/1\s*:\s*1|正方形|スクエア/.test(message)) return "1:1";
  return "16:9";
}

function productName(message: string): string {
  const labeled = message.match(/商品名\s*[:：]\s*([^\s。、]+)/);
  if (labeled?.[1]) return labeled[1].slice(0, 40);
  return "";
}

function scriptLines(message: string): string[] {
  const quoted = [...message.matchAll(/「([^」]{1,180})」/g)].map((match) => match[1].trim()).filter(Boolean);
  if (quoted.length > 0) return quoted.slice(0, 30);
  const labeled = message.match(/台本\s*[:：]\s*([\s\S]{1,2000})/);
  if (labeled?.[1]) {
    return labeled[1]
      .split(/\r?\n|\/|｜/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 30);
  }
  return [];
}

function productPoints(message: string): string {
  const labeled = message.match(/(?:紹介(?:したい点|文)?|要点|特徴)\s*[:：]\s*([^\n]{1,180})/);
  if (labeled?.[1]) return labeled[1].trim();
  const name = productName(message);
  if (!name) return "";
  const after = message.split(name).slice(1).join(name);
  const sentence = after.match(/[。！？]?\s*([^。\n]{4,80})/);
  return sentence?.[1]?.replace(/^[。\s]+/, "").trim() ?? "";
}

function distribute(lines: string[], total: number): SceneDraft[] {
  const count = Math.max(1, lines.length);
  const each = clampDuration(total / count);
  const scenes = lines.map((text, index) => ({
    title: index === 0 ? "導入" : index === lines.length - 1 ? "結び" : `シーン${index + 1}`,
    text: text.slice(0, 120),
    durationSeconds: each,
  }));
  const sum = scenes.reduce((totalSeconds, scene) => totalSeconds + scene.durationSeconds, 0);
  const drift = Math.round((total - sum) * 10) / 10;
  const last = scenes[scenes.length - 1];
  last.durationSeconds = clampDuration(last.durationSeconds + drift);
  return scenes;
}

export function isMuseVideoRequest(message: string): boolean {
  return VIDEO_REQUEST.test(message);
}

export function planMuseVideoRequest(message: string, attachments: MuseAttachmentKinds = {}): MuseVideoPlan {
  const text = message.trim();
  const missing: string[] = [];
  const wantsLipsync = /口パク|リップシンク|口の動き/.test(text);
  const wantsImage = /この画像|画像を使/.test(text) || wantsLipsync;
  const wantsVoice = /音声を合わせ|セリフ音声|ナレーション|声を付け|声優/.test(text) || wantsLipsync;
  const wantsBgm = /BGM|ｂｇｍ|音楽を付け|曲を付け/.test(text);
  const wantsDrama = /ドラマにして|この台本/.test(text);
  const wantsProduct = /商品紹介/.test(text);
  const lines = scriptLines(text);
  const name = productName(text);
  const points = productPoints(text);
  const duration = requestedDuration(text) ?? (wantsProduct ? 30 : null);

  if (wantsDrama && lines.length === 0) missing.push("台本");
  if (wantsProduct && !name && lines.length === 0) missing.push("商品名");
  if (wantsProduct && !points && lines.length === 0) missing.push("紹介する要点");
  if (wantsImage && !attachments.image && !attachments.lipsync) missing.push(wantsLipsync ? "人物の画像か口パク動画" : "画像");
  if (wantsVoice && !attachments.voice && !attachments.lipsync) missing.push("セリフ音声");
  if (wantsBgm && !attachments.bgm) missing.push("BGM");
  if (!duration && lines.length === 0 && !name) missing.push("動画の長さ");

  const storyboard = lines.length > 0
    ? lines
    : name
      ? [`${name}のご紹介`, points || `${name}の特徴`, `${name}を、今日の暮らしに。`].filter((line, index, all) => all.indexOf(line) === index)
      : [];

  if (storyboard.length === 0 && !missing.includes("台本") && !missing.includes("商品名")) {
    missing.push("台本または商品名");
  }

  if (storyboard.length === 0 || missing.length > 0) {
    const unique = [...new Set(missing)];
    return {
      ready: false,
      missing: unique,
      question: `動画を作る前に、次だけ教えてください：${unique.join("、")}。`,
      manifest: null,
      assetPaths: [],
    };
  }

  const total = duration ?? Math.min(900, Math.max(storyboard.length * 3, 3));
  const scenes = distribute(storyboard, total);
  const manifest: Record<string, unknown> = {
    format: "muse-motion-manifest",
    version: 1,
    aspect: requestedAspect(text),
    fps: 30,
    scenes: scenes.map((scene, index) => ({
      order: index + 1,
      title: scene.title,
      text: scene.text,
      durationSeconds: scene.durationSeconds,
      motionPreset: index === 0 ? "fade-up" : index === scenes.length - 1 ? "fade" : "soft-zoom",
      narrationAudioReady: Boolean(attachments.voice && index === 0),
    })),
    bgm: attachments.bgm ? { volume: 0.18, loop: true } : null,
    totalDurationSeconds: Math.round(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) * 10) / 10,
  };
  if (attachments.lipsync) manifest.lipsyncFile = "lipsync";
  else if (wantsLipsync && attachments.image && attachments.voice) {
    manifest.lipSync = { engine: "musetalk" };
    const first = manifest.scenes as Array<Record<string, unknown>>;
    first[0].imageFile = "scene-1";
  } else if (attachments.image) {
    const first = manifest.scenes as Array<Record<string, unknown>>;
    first[0].imageFile = "scene-1";
  }
  const optional = [
    attachments.voice || wantsVoice ? "" : "セリフ音声",
    attachments.bgm || wantsBgm ? "" : "BGM",
    attachments.lipsync || attachments.image || wantsLipsync || wantsImage ? "" : "人物画像または口パク動画",
  ].filter(Boolean);
  const started = optional.length > 0
    ? `Muse制作キューに登録します。まだ完成ではありません。未添付のため入らないもの：${optional.join("、")}。`
    : "Muse制作キューに登録します。完成するまで完了とは表示しません。";
  return {
    ready: true,
    missing: optional,
    question: started,
    manifest,
    assetPaths: [],
  };
}
