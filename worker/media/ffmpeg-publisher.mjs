import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";

const MAX_AUDIO_CHUNK_BYTES = 12 * 1024 * 1024;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".mp3", ".wav", ".m4a"]);

function resolveMediaPath(value, mediaRoot) {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_media_path");
  const root = path.resolve(mediaRoot);
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("media_path_outside_root");
  if (!ALLOWED_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error("unsupported_media_type");
  return resolved;
}

function validateOutputUrl(value, destination) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid_output_url");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_output_url"); }
  if (!["rtmp:", "rtmps:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("invalid_output_url");
  }
  if (destination === "youtube_live" && !/(^|\.)googlevideo\.com$/i.test(parsed.hostname) &&
      !/(^|\.)youtube\.com$/i.test(parsed.hostname)) {
    throw new Error("destination_host_mismatch");
  }
  if (destination === "tiktok_live" && !/(^|\.)tiktokcdn\.com$/i.test(parsed.hostname) &&
      !/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
    throw new Error("destination_host_mismatch");
  }
  return value;
}

export function buildFfmpegArgs({ videoPath, bgmPath, outputUrl, width = 1280, height = 720, fps = 30 }) {
  if (!Number.isInteger(width) || width < 320 || width > 1920 ||
      !Number.isInteger(height) || height < 240 || height > 1080 ||
      !Number.isInteger(fps) || fps < 15 || fps > 60) {
    throw new Error("invalid_output_profile");
  }
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-re", "-stream_loop", "-1", "-i", videoPath,
    "-f", "mp3", "-i", "pipe:0",
    "-stream_loop", "-1", "-i", bgmPath,
    "-filter_complex",
    "[1:a]aresample=async=1:first_pts=0[speech];[2:a]volume=0.18,aresample=async=1:first_pts=0[bgm];[speech][bgm]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aout]",
    "-map", "0:v:0", "-map", "[aout]",
    "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,fps=" + fps,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", String(fps * 2), "-keyint_min", String(fps * 2),
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv", outputUrl,
  ];
}

/**
 * One process per destination. Secrets are resolved just-in-time and are never
 * returned in status, error messages, or logs. No shell is involved.
 */
export function createFfmpegPublisher({
  secretResolver,
  mediaRoot = process.env.AI_LIVE_MEDIA_ROOT || "/app/media",
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  spawnImpl = nodeSpawn,
  onState = () => {},
} = {}) {
  if (typeof secretResolver !== "function") throw new Error("secretResolver is required");
  if (typeof spawnImpl !== "function") throw new Error("spawn implementation is required");

  let child = null;
  let state = "idle";
  let queuedBytes = 0;
  let closing = false;
  let failureCode = null;

  function snapshot() {
    return { state, queuedBytes, failureCode };
  }

  function setState(next, code = null) {
    state = next;
    failureCode = code;
    onState(snapshot());
  }

  async function writeChunk(bytes) {
    if (!child || state !== "publishing" || closing) throw new Error("publisher_not_running");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      throw new Error("invalid_audio_chunk");
    }
    if (queuedBytes + bytes.byteLength > MAX_QUEUE_BYTES) throw new Error("audio_queue_full");
    queuedBytes += bytes.byteLength;
    try {
      if (!child.stdin.write(Buffer.from(bytes))) await once(child.stdin, "drain");
    } finally {
      queuedBytes = Math.max(0, queuedBytes - bytes.byteLength);
    }
  }

  return {
    snapshot,
    async start({ destination, destinationSecretRef, videoFile, bgmFile, width, height, fps }) {
      if (state === "publishing") return snapshot();
      if (state === "starting" || state === "stopping") throw new Error("publisher_transition_in_progress");
      if (!["youtube_live", "tiktok_live"].includes(destination)) throw new Error("unsupported_destination");
      if (typeof destinationSecretRef !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(destinationSecretRef)) {
        throw new Error("invalid_secret_reference");
      }

      const videoPath = resolveMediaPath(videoFile, mediaRoot);
      const bgmPath = resolveMediaPath(bgmFile, mediaRoot);
      if (![".mp4", ".mov", ".mkv"].includes(path.extname(videoPath).toLowerCase())) throw new Error("video_file_required");
      if (![".mp3", ".wav", ".m4a"].includes(path.extname(bgmPath).toLowerCase())) throw new Error("bgm_file_required");

      setState("starting");
      let secret;
      try {
        secret = await secretResolver({ destination, secretRef: destinationSecretRef });
        const outputUrl = validateOutputUrl(secret?.outputUrl, destination);
        const args = buildFfmpegArgs({ videoPath, bgmPath, outputUrl, width, height, fps });
        const proc = spawnImpl(ffmpegPath, args, { shell: false, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
        child = proc;
        closing = false;
        proc.stderr?.on("data", () => {
          // FFmpeg diagnostics may echo destination URLs; never forward raw stderr.
        });
        proc.once("error", () => {
          if (child === proc) {
            child = null;
            setState("failed", "ffmpeg_spawn_failed");
          }
        });
        proc.once("exit", (code, signal) => {
          if (child === proc) {
            child = null;
            setState(code === 0 || closing ? "stopped" : "failed",
              code === 0 || closing ? null : "ffmpeg_exit_" + (signal ? "signal" : "nonzero"));
          }
        });
        setState("publishing");
        return snapshot();
      } catch (error) {
        child = null;
        setState("failed", error?.message === "destination_host_mismatch" ? "destination_host_mismatch" : "publisher_start_failed");
        throw new Error(state === "failed" ? failureCode : "publisher_start_failed");
      } finally {
        secret = null;
      }
    },
    async writeSpeechAudio(bytes) {
      return writeChunk(bytes);
    },
    async stop({ graceMs = 5000 } = {}) {
      if (!child) {
        if (state !== "failed") setState("stopped");
        return snapshot();
      }
      if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 15000) throw new Error("invalid_grace_period");
      const proc = child;
      closing = true;
      setState("stopping");
      try { proc.stdin.end(); } catch {}
      const exited = new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
        const timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
        proc.once("exit", () => { clearTimeout(timer); resolve(true); });
      });
      if (!(await exited)) {
        proc.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref?.();
          proc.once("exit", () => { clearTimeout(timer); resolve(); });
        });
        if (child === proc) proc.kill("SIGKILL");
      }
      if (child === proc) child = null;
      setState("stopped");
      return snapshot();
    },
  };
}
