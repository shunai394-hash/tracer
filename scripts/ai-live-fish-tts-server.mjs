import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AI_LIVE_TTS_PORT || 8787);
const API_KEY = process.env.FISH_AUDIO_API_KEY;
const pagePath = join(dirname(fileURLToPath(import.meta.url)), "ai-live-fish-session.html");

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(pagePath));
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ローカル音声テストページを読み込めません。");
    }
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, providerConfigured: Boolean(API_KEY), host: HOST }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/tts") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  if (!API_KEY) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("FISH_AUDIO_API_KEY が未設定です。");
    return;
  }
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 12_000) {
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("入力が長すぎます。");
        return;
      }
    }
    const parsed = JSON.parse(body);
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 1500) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("text は1〜1500文字で指定してください。");
      return;
    }
    const upstream = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", model: "drama-3" },
      body: JSON.stringify({ text: parsed.text, format: "mp3" }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 800);
      res.writeHead(upstream.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Fish Audio API error (${upstream.status}): ${detail}`);
      return;
    }
    const maxAudioBytes = 25 * 1024 * 1024;
    const chunks = [];
    let audioBytes = 0;
    for await (const chunk of upstream.body) {
      audioBytes += chunk.byteLength;
      if (audioBytes > maxAudioBytes) {
        throw new Error("AUDIO_TOO_LARGE");
      }
      chunks.push(Buffer.from(chunk));
    }
    if (audioBytes === 0) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("音声データが空です。");
      return;
    }
    const audio = Buffer.concat(chunks, audioBytes);
    res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") || "audio/mpeg", "Content-Length": audio.length });
    res.end(audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = message === "AUDIO_TOO_LARGE" ? 502 : 400;
    res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message === "AUDIO_TOO_LARGE"
      ? "音声データがサイズ上限を超えています。"
      : message.includes("JSON") ? "JSON形式が不正です。" : "要求を処理できませんでした。");
  }
});
server.listen(PORT, HOST, () => {
  console.log(`TRACER Fish Audio local proxy: http://${HOST}:${PORT}`);
  console.log(`Fish Audio API key: ${API_KEY ? "configured (value hidden)" : "not configured"}`);
});
