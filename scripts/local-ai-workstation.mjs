#!/usr/bin/env node
/**
 * Local-only AI workstation helpers for TRACER.
 * Ollama handles optional text assistance; OpenAI Whisper handles local
 * transcription. No provider keys, cloud endpoints, DB, or commerce writes.
 */
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function getLocalOllamaBaseUrl(value = process.env.OLLAMA_HOST) {
  const raw = value?.trim() || "http://127.0.0.1:11434";
  const url = new URL(raw);
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !allowedHosts.has(url.hostname) || url.username || url.password) {
    throw new Error("Ollama must use a local loopback HTTP address.");
  }
  return url.origin;
}

export function buildOllamaChatPayload(model, prompt) {
  const selectedModel = String(model || "").trim();
  const text = String(prompt || "").trim();
  if (!selectedModel) throw new Error("OLLAMA_MODEL is required. Set it to a model already installed in Ollama.");
  if (!text) throw new Error("A prompt is required.");
  if (text.length > 12000) throw new Error("Prompt is too long (maximum 12000 characters).");
  return {
    model: selectedModel,
    messages: [{ role: "user", content: text }],
    stream: false,
    options: { temperature: 0.3 },
  };
}

export function buildWhisperArgs(inputFile, outputDir, model = "small", language = "Japanese") {
  if (!inputFile || !String(inputFile).trim()) throw new Error("A media file path is required.");
  if (!outputDir || !String(outputDir).trim()) throw new Error("An output directory is required.");
  const selectedModel = String(model || "small").trim();
  if (!/^[a-z0-9._-]{1,40}$/i.test(selectedModel)) throw new Error("Invalid Whisper model name.");
  return [
    String(inputFile),
    "--model", selectedModel,
    "--language", String(language || "Japanese"),
    "--task", "transcribe",
    "--output_format", "srt",
    "--output_dir", String(outputDir),
  ];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getOllamaStatus() {
  const baseUrl = getLocalOllamaBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, 5000);
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const body = await response.json();
  return Array.isArray(body.models) ? body.models.map((model) => model.name).filter(Boolean) : [];
}

export async function askOllama(prompt, model = process.env.OLLAMA_MODEL) {
  const baseUrl = getLocalOllamaBaseUrl();
  const payload = buildOllamaChatPayload(model, prompt);
  const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const body = await response.json();
  const answer = body?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("Ollama returned no text.");
  return answer.trim();
}

function getWhisperLauncher() {
  const direct = spawnSync("whisper", ["--help"], {
    stdio: "ignore", windowsHide: true, shell: false, timeout: 10000,
  });
  if (!direct.error && direct.status === 0) return { command: "whisper", prefix: [] };

  // Windows Python installs often put whisper.exe in a Scripts directory that
  // is not on PATH. The Python module remains runnable through the py launcher.
  const python = spawnSync("py", ["-m", "whisper", "--help"], {
    stdio: "ignore", windowsHide: true, shell: false, timeout: 15000,
  });
  if (!python.error && python.status === 0) return { command: "py", prefix: ["-m", "whisper"] };
  return null;
}

function runWhisper(args) {
  const launcher = getWhisperLauncher();
  if (!launcher) {
    return Promise.reject(new Error(
      "Whisper was not found. Install it with 'py -m pip install -U openai-whisper' or add the Python Scripts folder to PATH.",
    ));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      stdio: "inherit", windowsHide: true, shell: false,
    });
    child.once("error", (error) => reject(new Error(`Whisper could not start: ${error.message}`)));
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`Whisper exited with code ${code ?? "unknown"}.`)));
  });
}

export async function transcribeWithWhisper(inputFile, outputDir = path.dirname(path.resolve(inputFile))) {
  const absoluteInput = path.resolve(inputFile);
  const absoluteOutput = path.resolve(outputDir);
  await access(absoluteInput);
  await mkdir(absoluteOutput, { recursive: true });
  const args = buildWhisperArgs(
    absoluteInput,
    absoluteOutput,
    process.env.WHISPER_MODEL || "small",
    process.env.WHISPER_LANGUAGE || "Japanese",
  );
  await runWhisper(args);
  return absoluteOutput;
}

function whisperInstalled() {
  return getWhisperLauncher() !== null;
}

function usage() {
  console.log([
    "TRACER Local AI Workstation (local-only)",
    "",
    "  node scripts/local-ai-workstation.mjs status",
    '  node scripts/local-ai-workstation.mjs ask "台本の自然な日本語を整えて"',
    '  node scripts/local-ai-workstation.mjs transcribe "C:\\media\\episode1.mp4" [output-directory]',
    "",
    "Environment:",
    "  OLLAMA_MODEL       Installed Ollama model name (required for ask)",
    "  OLLAMA_HOST        Loopback URL only; default http://127.0.0.1:11434",
    "  WHISPER_MODEL      Whisper model; default small",
    "  WHISPER_LANGUAGE   Language; default Japanese",
  ].join("\n"));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "status") {
    let models = [];
    let ollamaError = null;
    try { models = await getOllamaStatus(); } catch (error) { ollamaError = error.message; }
    const hasWhisper = whisperInstalled();
    console.log(JSON.stringify({
      mode: "local-only",
      ollama: { available: !ollamaError, models, error: ollamaError },
      whisper: { installed: hasWhisper },
      cloudApiCalls: false,
      databaseAccess: false,
      commerceWrites: false,
    }, null, 2));
    return;
  }
  if (command === "ask") {
    console.log(await askOllama(args.join(" ")));
    return;
  }
  if (command === "transcribe") {
    if (!args[0]) throw new Error("Provide a media file path.");
    const outputDir = args[1] || path.dirname(path.resolve(args[0]));
    const result = await transcribeWithWhisper(args[0], outputDir);
    console.log(`字幕ファイルの出力先: ${result}`);
    return;
  }
  usage();
  if (command && command !== "help") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
