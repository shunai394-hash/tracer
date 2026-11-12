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

/**
 * FFmpeg arguments for a local introduction: loop the avatar and BGM, duck BGM
 * under the speech file, and write a local file. A remote output is rejected.
 */
export function buildResidentFfmpegArgs(input: {
  avatarVideo: string;
  bgmPath: string;
  speechPath: string;
  outputPath: string;
}): { ok: true; args: string[] } | { ok: false; errorCode: string } {
  const paths = [input.avatarVideo, input.bgmPath, input.speechPath, input.outputPath];
  if (paths.some((value) => typeof value !== "string" || value.length < 1 || value.includes("://"))) {
    return { ok: false, errorCode: "media_output_rejected" };
  }
  const ducked = residentMixGains().ducked.toFixed(4);
  const filter = `[1:a]volume=${ducked},aloop=loop=-1:size=2000000000[bgm];[2:a]anull[speech];[bgm][speech]amix=inputs=2:duration=shortest:dropout_transition=0[a]`;
  return {
    ok: true,
    args: [
      "-y",
      "-stream_loop", "-1", "-i", input.avatarVideo,
      "-stream_loop", "-1", "-i", input.bgmPath,
      "-i", input.speechPath,
      "-filter_complex", filter,
      "-map", "0:v:0",
      "-map", "[a]",
      "-shortest",
      input.outputPath,
    ],
  };
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
