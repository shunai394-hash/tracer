import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOllamaChatPayload,
  buildWhisperArgs,
  getLocalOllamaBaseUrl,
} from "./local-ai-workstation.mjs";

test("Ollama endpoint is restricted to loopback", () => {
  assert.equal(getLocalOllamaBaseUrl(), "http://127.0.0.1:11434");
  assert.equal(getLocalOllamaBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.throws(() => getLocalOllamaBaseUrl("https://ollama.example.com"), /local loopback/);
  assert.throws(() => getLocalOllamaBaseUrl("http://192.168.1.10:11434"), /local loopback/);
});

test("Ollama payload requires an installed model and bounded prompt", () => {
  assert.deepEqual(buildOllamaChatPayload("qwen3:8b", "日本語の台本を整えて"), {
    model: "qwen3:8b",
    messages: [{ role: "user", content: "日本語の台本を整えて" }],
    stream: false,
    options: { temperature: 0.3 },
  });
  assert.throws(() => buildOllamaChatPayload("", "prompt"), /OLLAMA_MODEL/);
  assert.throws(() => buildOllamaChatPayload("qwen3:8b", " "), /prompt is required/);
  assert.throws(() => buildOllamaChatPayload("qwen3:8b", "x".repeat(12001)), /too long/);
});

test("Whisper receives safe argument boundaries and Japanese SRT defaults", () => {
  assert.deepEqual(buildWhisperArgs("C:\\media\\episode 1.mp4", "C:\\subs", "small"), [
    "C:\\media\\episode 1.mp4",
    "--model", "small",
    "--language", "Japanese",
    "--task", "transcribe",
    "--output_format", "srt",
    "--output_dir", "C:\\subs",
  ]);
  assert.throws(() => buildWhisperArgs("", "out"), /media file path/);
  assert.throws(() => buildWhisperArgs("in.mp4", "out", "../bad"), /Invalid Whisper/);
});
