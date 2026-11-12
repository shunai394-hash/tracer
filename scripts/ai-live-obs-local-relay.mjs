/**
 * Localhost-only bridge for an OBS Media Source.
 * The resident worker publishes RTMP. This process listens on 127.0.0.1
 * and serves the same program as HLS on 127.0.0.1. It is not OBS Studio.
 */
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return process.argv[index + 1] || "";
}

function loopbackRtmpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port);
  if (parsed.protocol !== "rtmp:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(parsed.pathname)) return null;
  return value;
}

const requestedUrl = argumentValue("--rtmp-url");
const directory = argumentValue("--directory") || join(tmpdir(), "tracer-obs-relay");
mkdirSync(directory, { recursive: true });

const rtmpPort = Number(argumentValue("--rtmp-port") || 0) || await reservePort();
const rtmpUrl = loopbackRtmpUrl(requestedUrl || `rtmp://127.0.0.1:${rtmpPort}/live/obs`);
if (!rtmpUrl) {
  console.log(JSON.stringify({ ok: false, errorCode: "loopback_required", obsStudio: false }));
  process.exit(1);
}

const playlist = join(directory, "index.m3u8");
const segmentPattern = join(directory, "seg_%d.ts").replaceAll("\\", "/");
const ffmpeg = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-listen", "1", "-i", rtmpUrl,
  "-c", "copy",
  "-f", "hls",
  "-hls_time", "1",
  "-hls_list_size", "8",
  "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
  "-hls_segment_filename", segmentPattern,
  playlist.replaceAll("\\", "/"),
], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

let ffmpegError = "";
ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk.toString("utf8").slice(-2000); });

const server = createServer((request, response) => {
  const name = basename(new URL(request.url || "/", "http://127.0.0.1").pathname);
  if (!/^(index\.m3u8|seg_\d+\.ts)$/.test(name)) {
    response.writeHead(404);
    response.end();
    return;
  }
  const file = join(directory, name);
  if (!existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  const body = readFileSync(file);
  const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
});

const httpPort = Number(argumentValue("--http-port") || 0);
server.listen(httpPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || address.address !== "127.0.0.1") {
    console.log(JSON.stringify({ ok: false, errorCode: "loopback_required", obsStudio: false }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    host: address.address,
    rtmpUrl,
    hlsUrl: `http://127.0.0.1:${address.port}/index.m3u8`,
    obsStudio: false,
  }));
});

function shutdown() {
  ffmpeg.kill("SIGKILL");
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
ffmpeg.once("exit", () => {
  if (ffmpegError) console.error(ffmpegError.slice(-500));
});
