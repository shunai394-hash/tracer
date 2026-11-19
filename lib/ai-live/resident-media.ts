import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isConsentedCustomJapaneseVoice } from "./fish-audio-consented-custom-voices.ts";
import { SPEECH_DUCK_FADE_MS, SPEECH_DUCK_RATIO, speechMixVolume } from "./program.ts";

function registeredDramaVoiceIds(): string[] {
  try {
    const source = readFileSync(fileURLToPath(new URL("./fish-audio-drama-character-voices.ts", import.meta.url)), "utf8");
    return [...source.matchAll(/id:\s*"([a-zA-Z0-9_-]{8,128})"/g)].map((match) => match[1]);
  } catch {
    return [];
  }
}

/** Operator base volume for the resident mix. The duck ratio stays in program.ts. */
export const RESIDENT_BGM_BASE_VOLUME = 0.35;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

export function isRegisteredResidentVoice(voiceId: string): boolean {
  return isConsentedCustomJapaneseVoice(voiceId) || registeredDramaVoiceIds().includes(voiceId);
}

export function residentMixGains(): { base: number; ducked: number; duckRatio: number } {
  return {
    base: RESIDENT_BGM_BASE_VOLUME,
    ducked: speechMixVolume(RESIDENT_BGM_BASE_VOLUME, "duck", SPEECH_DUCK_FADE_MS),
    duckRatio: SPEECH_DUCK_RATIO,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Optional OBS ingest. Only an RTMP URL on 127.0.0.1 or localhost is accepted.
 * Anything else, including YouTube and TikTok ingest hosts, is rejected.
 */
export function residentLoopbackTarget(value: unknown): { ok: true; url: string | null } | { ok: false; errorCode: "media_output_rejected" } {
  if (value == null || value === "") return { ok: true, url: null };
  if (typeof value !== "string") return { ok: false, errorCode: "media_output_rejected" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, url: null };
  if (/\s/.test(trimmed)) return { ok: false, errorCode: "media_output_rejected" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, errorCode: "media_output_rejected" };
  }
  const port = Number(parsed.port);
  if (parsed.protocol !== "rtmp:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, errorCode: "media_output_rejected" };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return { ok: false, errorCode: "media_output_rejected" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, errorCode: "media_output_rejected" };
  if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(parsed.pathname)) return { ok: false, errorCode: "media_output_rejected" };
  return { ok: true, url: trimmed };
}

/**
 * BGM stays at the 0.35 base. While speech is present, sidechaincompress
 * lowers it over SPEECH_DUCK_FADE_MS and releases afterward. Threshold 0.108 is calibrated against the boosted detector signal; the
 * speech audio sent to the mix remains at its original level.
 */
function residentDuckFilter(splitProgram: boolean, speechInputCount: number): string {
  const base = RESIDENT_BGM_BASE_VOLUME.toFixed(4);
  const mixed = splitProgram ? "[amixed]" : "[a]";
  const lines = [
    `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,volume=${base},aloop=loop=-1:size=2000000000[bgm]`,
  ];
  if (speechInputCount > 1) {
    const speechInputs = Array.from({ length: speechInputCount }, (_, index) => {
      const inputIndex = index + 2;
      const output = `[speech${index}]`;
      lines.push(`[${inputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono${output}`);
      return output;
    });
    lines.push(`${speechInputs.join("")}concat=n=${speechInputCount}:v=0:a=1[spoken]`);
  } else {
    lines.push("[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[spoken]");
  }
  lines.push(
    // Boost only the detector path by 12 dB so quieter synthesized speech
    // still triggers ducking. The audible speech path remains untouched.
    "[spoken]apad,asplit=2[speech][key]",
    "[key]volume=4.0[duck-key]",
    `[bgm][duck-key]sidechaincompress=threshold=0.108:ratio=20:attack=${SPEECH_DUCK_FADE_MS}:release=${SPEECH_DUCK_FADE_MS}:knee=1:detection=peak:makeup=1[ducked]`,
    `[ducked][speech]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0${mixed}`,
  );
  if (splitProgram) lines.push("[amixed]asplit=2[a0][a1]");
  return lines.join(";");
}

/**
 * Local MP4 plus, when requested, a second output on the loopback ingest.
 * A remote file or remote ingest URL is rejected before FFmpeg starts.
 */
export function buildResidentFfmpegArgs(input: {
  avatarVideo: string;
  bgmPath: string;
  speechPath: string;
  speechPaths?: string[];
  outputPath: string;
  loopbackUrl?: string | null;
}): { ok: true; args: string[] } | { ok: false; errorCode: "media_output_rejected" } {
  const speechPaths = input.speechPaths ?? [input.speechPath];
  if (!Array.isArray(speechPaths) || speechPaths.length < 1 || speechPaths.length > 20) {
    return { ok: false, errorCode: "media_output_rejected" };
  }
  const paths = [input.avatarVideo, input.bgmPath, ...speechPaths, input.outputPath];
  if (paths.some((value) => typeof value !== "string" || value.length < 1 || value.includes("://"))) {
    return { ok: false, errorCode: "media_output_rejected" };
  }
  const loopback = residentLoopbackTarget(input.loopbackUrl ?? null);
  if (!loopback.ok) return loopback;
  const encode = [
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
  ];
  const speechInputs = speechPaths.flatMap((path) => ["-re", "-i", path]);
  const args = [
    "-y",
    "-re", "-stream_loop", "-1", "-i", input.avatarVideo,
    "-re", "-stream_loop", "-1", "-i", input.bgmPath,
    ...speechInputs,
    "-filter_complex", residentDuckFilter(loopback.url !== null, speechPaths.length),
    "-map", "0:v:0",
    "-map", loopback.url ? "[a0]" : "[a]",
    ...encode,
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    input.outputPath,
  ];
  if (loopback.url) {
    args.push("-map", "0:v:0", "-map", "[a1]", ...encode, "-f", "flv", loopback.url);
  }
  return { ok: true, args };
}

export async function synthesizeRegisteredVoice(input: {
  voiceId: string;
  text: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
}): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; errorCode: string }> {
  if (!isRegisteredResidentVoice(input.voiceId)) return { ok: false, errorCode: "voice_not_registered" };
  if (!input.apiKey || !input.text.trim() || input.text.length > 1200) return { ok: false, errorCode: "speech_provider_failed" };
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        model: input.model || "s2.1-pro-free",
      },
      body: JSON.stringify({
        text: input.text,
        reference_id: input.voiceId,
        format: "mp3",
        prosody: { speed: 1 },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, errorCode: "speech_provider_failed" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1000) return { ok: false, errorCode: "speech_provider_failed" };
    return { ok: true, bytes };
  } catch {
    return { ok: false, errorCode: "speech_provider_failed" };
  }
}
