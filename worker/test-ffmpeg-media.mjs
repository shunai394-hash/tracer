import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { renderAiLiveSegment } from "./ffmpeg-media.mjs";

const root = await mkdtemp(path.join(tmpdir(), "tracer-ai-live-media-"));
const outside = await mkdtemp(path.join(tmpdir(), "tracer-ai-live-outside-"));
const mediaDir = path.join(root, "media");
const outputDir = path.join(root, "out");
await mkdir(mediaDir);
await mkdir(outputDir);
await writeFile(path.join(mediaDir, "slate.png"), Buffer.from("png-fixture"));
await writeFile(path.join(mediaDir, "voice.wav"), Buffer.from("wav-fixture"));
await writeFile(path.join(mediaDir, "music.mp3"), Buffer.from("mp3-fixture"));
await writeFile(path.join(outside, "external.wav"), Buffer.from("external"));
await symlink(path.join(outside, "external.wav"), path.join(mediaDir, "escape.wav"));

const calls = [];
function fakeSpawn(command, args, options) {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.kill = () => true;
  process.nextTick(() => child.emit("close", 0, null));
  return child;
}

try {
  const rendered = await renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    bgmPath: "media/music.mp3", outputPath: "out/segment.mp4",
    spawnImpl: fakeSpawn,
  });
  assert.equal(rendered.hasBgm, true);
  assert.equal(rendered.durationLimitSeconds, 600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg");
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes("-protocol_whitelist"));
  assert.ok(calls[0].args.includes("file,pipe"));
  assert.ok(calls[0].args.includes("amix=inputs=2"));
  assert.ok(calls[0].args.includes("-f"));
  assert.ok(calls[0].args.includes("mp4"));
  assert.ok(!calls[0].args.some((arg) => /^rtmps?:\/\//i.test(arg)));

  const noBgm = await renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    outputPath: "out/voice-only.mp4", spawnImpl: fakeSpawn,
  });
  assert.equal(noBgm.hasBgm, false);
  assert.ok(!calls[1].args.includes("-filter_complex"));

  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/escape.wav",
    outputPath: "out/escape.mp4", spawnImpl: fakeSpawn,
  }), /outside_media_root/);
  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "https://example.invalid/slate.png", voicePath: "media/voice.wav",
    outputPath: "out/remote.mp4", spawnImpl: fakeSpawn,
  }), /must_be_local_file/);
  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    outputPath: "../escape.mp4", spawnImpl: fakeSpawn,
  }), /outside_media_root/);
  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    outputPath: "out/invalid.mov", spawnImpl: fakeSpawn,
  }), /must_be_mp4/);
  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    outputPath: "out/long.mp4", maxDurationSeconds: 3600, spawnImpl: fakeSpawn,
  }), /duration_out_of_bounds/);
  await assert.rejects(() => renderAiLiveSegment({
    mediaRoot: root, imagePath: "media/slate.png", voicePath: "media/voice.wav",
    outputPath: "out/loud.mp4", bgmVolume: 0.9, spawnImpl: fakeSpawn,
  }), /bgm_volume_out_of_bounds/);
  console.log("AI Live FFmpeg media renderer: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
