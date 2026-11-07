import { spawn } from "node:child_process";
import { realpath, stat, lstat } from "node:fs/promises";
import path from "node:path";

const MAX_INPUT_BYTES = 250 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;
const MIN_DURATION_SECONDS = 10;
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveLocalFile(mediaRoot, inputPath, extensions, label) {
  if (typeof inputPath !== "string" || !inputPath || inputPath.includes("\0")) throw new Error(label + "_path_invalid");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) throw new Error(label + "_must_be_local_file");
  const root = await realpath(mediaRoot);
  const actual = await realpath(path.resolve(root, inputPath));
  if (!isWithin(root, actual)) throw new Error(label + "_outside_media_root");
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(label + "_not_regular_file");
  if (info.size < 1 || info.size > MAX_INPUT_BYTES) throw new Error(label + "_size_out_of_bounds");
  if (!extensions.has(path.extname(actual).toLowerCase())) throw new Error(label + "_extension_not_allowed");
  return actual;
}

async function resolveOutput(mediaRoot, outputPath) {
  if (typeof outputPath !== "string" || !outputPath || outputPath.includes("\0")) throw new Error("output_path_invalid");
  const root = await realpath(mediaRoot);
  const candidate = path.resolve(root, outputPath);
  const parent = await realpath(path.dirname(candidate));
  if (!isWithin(root, parent)) throw new Error("output_outside_media_root");
  if (path.extname(candidate).toLowerCase() !== ".mp4") throw new Error("output_must_be_mp4");
  try {
    const existing = await lstat(candidate);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("output_target_not_regular_file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path.join(parent, path.basename(candidate));
}

function runFfmpeg(args, { ffmpegPath, spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let forceKillTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error?.message !== "ffmpeg_timeout") clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve();
    };
    const timeoutTimer = setTimeout(() => {
      child?.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child?.kill("SIGKILL"), 3000);
      forceKillTimer.unref?.();
      finish(new Error("ffmpeg_timeout"));
    }, timeoutMs);
    try {
      child = spawnImpl(ffmpegPath, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
      child.once("error", () => finish(new Error("ffmpeg_spawn_failed")));
      child.once("close", (code) => finish(code === 0 ? null : new Error("ffmpeg_render_failed")));
    } catch {
      finish(new Error("ffmpeg_spawn_failed"));
    }
  });
}

/** Render local image + TTS + optional looped BGM to an MP4. Never publishes. */
export async function renderAiLiveSegment({
  mediaRoot, imagePath, voicePath, bgmPath = null, outputPath,
  maxDurationSeconds = 600, bgmVolume = 0.16,
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  spawnImpl = spawn, timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < MIN_DURATION_SECONDS || maxDurationSeconds > MAX_DURATION_SECONDS) {
    throw new Error("duration_out_of_bounds");
  }
  if (typeof bgmVolume !== "number" || !Number.isFinite(bgmVolume) || bgmVolume < 0 || bgmVolume > 0.5) {
    throw new Error("bgm_volume_out_of_bounds");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15 * 60 * 1000) throw new Error("timeout_out_of_bounds");

  const [image, voice, bgm, output] = await Promise.all([
    resolveLocalFile(mediaRoot, imagePath, IMAGE_EXTENSIONS, "image"),
    resolveLocalFile(mediaRoot, voicePath, AUDIO_EXTENSIONS, "voice"),
    bgmPath ? resolveLocalFile(mediaRoot, bgmPath, AUDIO_EXTENSIONS, "bgm") : Promise.resolve(null),
    resolveOutput(mediaRoot, outputPath),
  ]);

  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", "30", "-protocol_whitelist", "file,pipe", "-i", image,
    "-protocol_whitelist", "file,pipe", "-i", voice,
  ];
  if (bgm) {
    args.push("-stream_loop", "-1", "-protocol_whitelist", "file,pipe", "-i", bgm);
    args.push(
      "-filter_complex",
      "[1:a]aresample=async=1:first_pts=0[voice];[2:a]aresample=async=1:first_pts=0,volume=" + bgmVolume.toFixed(2) + "[bgm];[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]",
      "-map", "0:v:0", "-map", "[aout]",
    );
  } else {
    args.push("-map", "0:v:0", "-map", "1:a:0");
  }
  args.push(
    "-t", String(maxDurationSeconds), "-shortest",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024", "-f", "mp4", output,
  );
  await runFfmpeg(args, { ffmpegPath, spawnImpl, timeoutMs });
  return { outputPath: output, durationLimitSeconds: maxDurationSeconds, hasBgm: Boolean(bgm) };
}
