/**
 * Local rehearsal for the AI live program. This process is intentionally not
 * a Vercel function. It does not open RTMP, does not print credentials, and
 * does not mark YouTube or TikTok as live.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowViewerComment,
  buildProductScript,
  nextIntroducibleIndex,
  speechMixVolume,
  tiktokReadiness,
  youtubeReadiness,
} from "../lib/ai-live/program.ts";

const fixture = [
  {
    id: "rehearsal-bag",
    title: "レザー調 レディースハンドバッグ",
    description: "肩から掛けられる大きめのバッグです。",
    sellingPrice: 12800,
    currency: "JPY",
    inStock: true,
    productUrl: "https://tracer.base.ec/items/rehearsal-bag",
    imageUrl: "https://example.com/rehearsal-bag.jpg",
  },
  {
    id: "sold-out",
    title: "売り切れ商品",
    description: null,
    sellingPrice: 3000,
    currency: "JPY",
    inStock: false,
    productUrl: "https://tracer.base.ec/items/sold-out",
    imageUrl: null,
  },
];

function present(name) {
  return Boolean(process.env[name]?.trim());
}

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // A missing local env file only means the rehearsal cannot call providers.
  }
}

function mixCheck() {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ffmpeg.status !== 0) return { checked: false, reason: "ffmpeg_not_installed" };
  const dir = mkdtempSync(join(tmpdir(), "tracer-ai-live-"));
  const bed = join(dir, "bed.wav");
  const ducked = join(dir, "ducked.wav");
  try {
    const bedGain = speechMixVolume(0.35, "bed", 0);
    const duckGain = speechMixVolume(0.35, "duck", 400);
    const make = (gain, output) => spawnSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-filter:a", `volume=${gain.toFixed(4)}`,
      output,
    ], { encoding: "utf8" });
    if (make(bedGain, bed).status !== 0 || make(duckGain, ducked).status !== 0) {
      return { checked: false, reason: "ffmpeg_mix_failed" };
    }
    const detect = (file) => {
      const probe = spawnSync("ffmpeg", ["-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      const match = `${probe.stdout}\n${probe.stderr}`.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
      return match ? Number(match[1]) : null;
    };
    const bedDb = detect(bed);
    const duckDb = detect(ducked);
    if (bedDb === null || duckDb === null || !(duckDb < bedDb)) {
      return { checked: false, reason: "duck_not_quieter" };
    }
    return { checked: true, bedDb, duckDb, restored: speechMixVolume(0.35, "restore", 400) === 0.35 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fishProbe() {
  if (!present("FISH_AUDIO_API_KEY")) return { checked: false, reason: "FISH_AUDIO_API_KEY" };
  const response = await fetch("https://api.fish.audio/model?language=ja&licensed=true&page_size=1&page_number=1&sort_by=score", {
    headers: { Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return { checked: false, reason: "fish_audio_http_" + response.status };
  const payload = await response.json().catch(() => null);
  const voice = payload?.items?.find((item) => typeof item?._id === "string" || typeof item?.id === "string");
  const referenceId = voice?._id || voice?.id;
  if (typeof referenceId !== "string") return { checked: false, reason: "fish_audio_voice_missing" };
  let audio = null;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const spoken = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
        "Content-Type": "application/json",
        model: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free",
      },
      body: JSON.stringify({ text: "こちらは動作確認です。", reference_id: referenceId, format: "mp3", prosody: { speed: 1 } }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    lastStatus = spoken.status;
    if (spoken.ok) {
      audio = Buffer.from(await spoken.arrayBuffer());
      break;
    }
    await spoken.arrayBuffer().catch(() => undefined);
  }
  if (!audio || audio.byteLength < 1000) return { checked: false, reason: "fish_audio_tts_http_" + lastStatus };
  return { checked: true, bytes: audio.byteLength, attemptsUsed: audio ? true : false };
}

loadEnvFile(process.env.TRACER_ENV_FILE || "");

const index = nextIntroducibleIndex(fixture, 0);
if (index === null) {
  console.log(JSON.stringify({ ok: false, reason: "no_sellable_product" }));
  process.exit(1);
}
const first = buildProductScript(fixture[index], 0);
const second = buildProductScript(fixture[index], 1);
const comment = allowViewerComment({
  text: "価格はいくらですか",
  authorKey: "viewer",
  nowMs: 1_000,
  recent: [],
});
const burst = allowViewerComment({
  text: "価格はいくらですか",
  authorKey: "viewer",
  nowMs: 2_000,
  recent: Array.from({ length: 4 }, () => ({ authorKey: "viewer", text: "a", atMs: 1_900 })),
});

const report = {
  ok: true,
  live: false,
  rehearsal: true,
  productId: fixture[index].id,
  scriptChangesBetweenRotations: first !== second,
  scriptHasPrice: first.includes("12,800円"),
  soldOutSkipped: index === 0,
  commentAllowed: comment.allow,
  burstBlocked: burst.allow === false,
  duckFloor: speechMixVolume(0.35, "duck", 400),
  mix: mixCheck(),
  fishAudio: process.argv.includes("--speak") ? await fishProbe() : { checked: false, reason: "speak_probe_not_requested" },
  youtube: youtubeReadiness({
    clientId: present("YOUTUBE_CLIENT_ID"),
    clientSecret: present("YOUTUBE_CLIENT_SECRET"),
    refreshToken: present("YOUTUBE_REFRESH_TOKEN"),
  }),
  tiktok: tiktokReadiness(present("TIKTOK_RTMP_URL") && present("TIKTOK_STREAM_KEY")),
};

if (process.argv.includes("--write-status")) {
  const output = process.env.TRACER_AI_LIVE_STATUS || "";
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report));
if (!report.mix.checked && report.mix.reason !== "ffmpeg_not_installed") process.exitCode = 1;
