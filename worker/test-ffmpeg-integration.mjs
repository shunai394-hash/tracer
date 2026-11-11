import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderAiLiveSegment } from "./ffmpeg-media.mjs";

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      command + " failed: " + (result.error?.message || result.stderr || result.status),
    );
  }
  return result.stdout.trim();
}

function probe(file) {
  const streams = run(ffprobePath, [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name",
    "-of", "csv=p=0", file,
  ]);
  const duration = Number(run(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]));
  assert.match(streams, /h264,video|video,h264/);
  assert.match(streams, /aac,audio|audio,aac/);
  assert.ok(Number.isFinite(duration) && duration >= 0.8 && duration <= 1.5,
    "unexpected rendered duration: " + duration);
}

const root = await mkdtemp(path.join(tmpdir(), "tracer-ai-live-ffmpeg-integration-"));
const media = path.join(root, "media");
const output = path.join(root, "out");
await mkdir(media);
await mkdir(output);

try {
  run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
    "-frames:v", "1", path.join(media, "slate.png"),
  ]);
  run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "pcm_s16le", path.join(media, "voice.wav"),
  ]);
  run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=1.5",
    "-c:a", "pcm_s16le", path.join(media, "music.wav"),
  ]);

  const withBgm = await renderAiLiveSegment({
    mediaRoot: root,
    imagePath: "media/slate.png",
    voicePath: "media/voice.wav",
    bgmPath: "media/music.wav",
    outputPath: "out/with-bgm.mp4",
    maxDurationSeconds: 10,
    timeoutMs: 60_000,
    ffmpegPath,
  });
  assert.equal(withBgm.hasBgm, true);
  assert.ok((await stat(withBgm.outputPath)).size > 1024);
  probe(withBgm.outputPath);

  const voiceOnly = await renderAiLiveSegment({
    mediaRoot: root,
    imagePath: "media/slate.png",
    voicePath: "media/voice.wav",
    outputPath: "out/voice-only.mp4",
    maxDurationSeconds: 10,
    timeoutMs: 60_000,
    ffmpegPath,
  });
  assert.equal(voiceOnly.hasBgm, false);
  assert.ok((await stat(voiceOnly.outputPath)).size > 1024);
  probe(voiceOnly.outputPath);

  console.log("AI Live FFmpeg integration: real MP4 files with BGM and voice-only audio verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}
