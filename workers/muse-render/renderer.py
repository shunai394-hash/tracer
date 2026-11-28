#!/usr/bin/env python3
"""Render a validated Muse motion manifest to MP4 with FFmpeg.

This worker is deliberately local-file-only. The queue adapter must download
approved Supabase assets into an isolated job directory before invoking it.
Studio jobs and chat jobs use this same renderer.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

PRESETS = {"fade-up", "soft-zoom", "slide-left", "pop", "fade"}
ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
MAX_SCENES = 120
MAX_DURATION = 60.0
MAX_TOTAL = 900.0
ASSET_NAME = re.compile(r"scene-[1-9][0-9]*")


def validate_manifest(data: object) -> dict:
    if not isinstance(data, dict) or data.get("format") != "muse-motion-manifest" or data.get("version") != 1:
        raise ValueError("Unsupported Muse motion manifest")
    scenes = data.get("scenes")
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= MAX_SCENES:
        raise ValueError("Manifest must contain 1..120 scenes")
    aspect = data.get("aspect", "16:9")
    if aspect not in ASPECTS:
        raise ValueError("Unsupported aspect ratio")
    lipsync = data.get("lipsyncFile")
    if lipsync is not None and lipsync != "lipsync":
        raise ValueError("Invalid lip-sync asset name")
    total = 0.0
    clean = []
    for index, item in enumerate(scenes):
        if not isinstance(item, dict):
            raise ValueError(f"Scene {index + 1} must be an object")
        duration = item.get("durationSeconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0.5 <= duration <= MAX_DURATION:
            raise ValueError(f"Scene {index + 1} has invalid duration")
        preset = item.get("motionPreset")
        if preset not in PRESETS:
            raise ValueError(f"Scene {index + 1} has unsupported motion preset")
        title = str(item.get("title", ""))[:120]
        text = str(item.get("text", ""))[:500]
        image_file = item.get("imageFile")
        video_file = item.get("videoFile")
        if image_file is not None and (not isinstance(image_file, str) or not ASSET_NAME.fullmatch(image_file)):
            raise ValueError(f"Scene {index + 1} has invalid image asset name")
        if video_file is not None and (not isinstance(video_file, str) or not ASSET_NAME.fullmatch(video_file)):
            raise ValueError(f"Scene {index + 1} has invalid video asset name")
        if image_file and video_file:
            raise ValueError(f"Scene {index + 1} cannot use both image and video backgrounds")
        clean.append({
            "title": title,
            "text": text,
            "durationSeconds": float(duration),
            "motionPreset": preset,
            "imageFile": image_file,
            "videoFile": video_file,
        })
        total += float(duration)
    if total > MAX_TOTAL:
        raise ValueError("Total duration exceeds 15 minutes")
    bgm_volume = 0.18
    bgm_loop = True
    bgm = data.get("bgm")
    if isinstance(bgm, dict):
        raw_volume = bgm.get("volume")
        if isinstance(raw_volume, (int, float)) and not isinstance(raw_volume, bool) and math.isfinite(raw_volume):
            bgm_volume = min(0.45, max(0.0, float(raw_volume)))
        if bgm.get("loop") is False:
            bgm_loop = False
    return {
        "scenes": clean,
        "totalDurationSeconds": total,
        "fps": 30,
        "aspect": aspect,
        "lipsyncFile": lipsync,
        "bgmVolume": bgm_volume,
        "bgmLoop": bgm_loop,
    }


def run(command: list[str]) -> None:
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-1800:]
        raise RuntimeError(detail or f"FFmpeg failed with exit {completed.returncode}")


def drawtext_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%").replace(",", "\\,").replace("[", "\\[").replace("]", "\\]")


def font_filter_path(font: str) -> str:
    return drawtext_escape(font.replace("\\", "/"))


def probe_duration(path: Path) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 0.0
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if completed.returncode != 0:
        return 0.0
    try:
        return max(0.0, float(completed.stdout.strip()))
    except ValueError:
        return 0.0


def find_asset(assets_dir: Path, name: str | None, extensions: tuple[str, ...]) -> Path | None:
    if not name:
        return None
    for extension in extensions:
        candidate = (assets_dir / f"{name}{extension}").resolve()
        if candidate.is_file() and assets_dir in candidate.parents:
            return candidate
    return None


def render(manifest_path: Path, assets_dir: Path, output: Path, font: str) -> None:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = validate_manifest(data)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required")
    assets_dir = assets_dir.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = ASPECTS[manifest["aspect"]]
    total = manifest["totalDurationSeconds"]
    font_path = font_filter_path(font)
    with tempfile.TemporaryDirectory(prefix="muse-render-") as temp:
        tempdir = Path(temp)
        silent = tempdir / "silent.mp4"
        lipsync_path = find_asset(assets_dir, manifest.get("lipsyncFile"), (".mp4", ".webm"))
        if manifest.get("lipsyncFile") and lipsync_path is None:
            raise ValueError("Lip-sync video asset is missing")
        if lipsync_path is not None:
            # The browser/MuseTalk clip already contains mouth motion and captions.
            # Its embedded audio is dropped so Fish dialogue and BGM are mixed once.
            probed = probe_duration(lipsync_path)
            vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps=30,format=yuv420p"
            if probed > 0 and total - probed > 0.05:
                vf += f",tpad=stop_mode=clone:stop_duration={total - probed:.3f}"
            run([ffmpeg, "-y", "-i", str(lipsync_path), "-t", f"{total:.3f}", "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(silent)])
        else:
            clips = []
            for index, scene in enumerate(manifest["scenes"]):
                duration = scene["durationSeconds"]
                clip = tempdir / f"scene-{index:03d}.mp4"
                text = drawtext_escape(scene["text"] or scene["title"])
                x_expr = "(w-text_w)/2"
                y_expr = "(h-text_h)/2"
                size_expr = "68"
                if scene["motionPreset"] == "slide-left":
                    x_expr = "(w-text_w)/2+240*(1-min(t/0.55\\,1))"
                elif scene["motionPreset"] == "fade-up":
                    y_expr = "(h-text_h)/2+60*(1-min(t/0.55\\,1))"
                elif scene["motionPreset"] == "soft-zoom":
                    size_expr = "68*(0.88+0.12*min(t/0.8\\,1))"
                elif scene["motionPreset"] == "pop":
                    size_expr = "68*(0.72+0.28*min(t/0.32\\,1))"
                draw = f"drawtext=fontfile='{font_path}':text='{text}':fontcolor=white:fontsize='{size_expr}':borderw=3:bordercolor=black@0.65:x='{x_expr}':y='{y_expr}',fade=t=in:st=0:d=0.35,fade=t=out:st={max(0, duration - 0.35)}:d=0.35,format=yuv420p"
                video_path = find_asset(assets_dir, scene.get("videoFile"), (".mp4", ".webm"))
                image_path = find_asset(assets_dir, scene.get("imageFile"), (".png", ".jpg", ".jpeg", ".webp"))
                if scene.get("videoFile"):
                    if video_path is None:
                        raise ValueError(f"Scene {index + 1} video asset is missing")
                    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps=30,{draw}"
                    command = [ffmpeg, "-y", "-stream_loop", "-1", "-i", str(video_path), "-t", f"{duration:.3f}", "-vf", vf]
                elif scene.get("imageFile"):
                    if image_path is None:
                        raise ValueError(f"Scene {index + 1} image asset is missing")
                    camera = ""
                    if scene["motionPreset"] == "soft-zoom":
                        camera = f",zoompan=z='min(zoom+0.0007\\,1.06)':d=1:s={width}x{height}:fps=30"
                    elif scene["motionPreset"] == "slide-left":
                        camera = f",zoompan=z='1.04':x='(iw-iw/zoom)*on/{max(1.0, duration * 30.0)}':y='(ih-ih/zoom)/2':d=1:s={width}x{height}:fps=30"
                    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1{camera},{draw}"
                    command = [ffmpeg, "-y", "-loop", "1", "-framerate", "30", "-t", f"{duration:.3f}", "-i", str(image_path), "-vf", vf]
                else:
                    command = [ffmpeg, "-y", "-f", "lavfi", "-i", f"color=c=0x101827:s={width}x{height}:r=30:d={duration:.3f}", "-vf", draw]
                run([*command, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(clip)])
                clips.append(clip)
            concat = tempdir / "concat.txt"
            concat.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips), encoding="utf-8")
            run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(silent)])

        voice_files = []
        for index in range(len(manifest["scenes"])):
            candidate = (assets_dir / f"voice-{index + 1}.mp3").resolve()
            if candidate.exists() and candidate.is_file() and assets_dir in candidate.parents:
                voice_files.append((index, candidate, manifest["scenes"][index]["durationSeconds"]))
        if not voice_files:
            narration = (assets_dir / "narration.mp3").resolve()
            if narration.exists() and narration.is_file() and assets_dir in narration.parents:
                voice_files.append((0, narration, total))
        bgm = (assets_dir / "bgm.mp3").resolve()
        has_bgm = bgm.exists() and bgm.is_file() and assets_dir in bgm.parents and manifest["bgmVolume"] > 0
        inputs = ["-i", str(silent)]
        filters = []
        mix_labels = []
        for ordinal, (index, path, scene_duration) in enumerate(voice_files):
            input_no = ordinal + 1
            inputs += ["-i", str(path)]
            start = 0.0 if scene_duration == total and ordinal == 0 and path.name == "narration.mp3" else sum(scene["durationSeconds"] for scene in manifest["scenes"][:index])
            delay = max(0, int(round(start * 1000)))
            label = f"v{index}"
            filters.append(
                f"[{input_no}:a]atrim=0:{scene_duration:.3f},asetpts=PTS-STARTPTS,"
                f"adelay={delay}:all=1,apad=whole_dur={total:.3f},atrim=0:{total:.3f},volume=1[{label}]"
            )
            mix_labels.append(f"[{label}]")
        if has_bgm:
            input_no = 1 + len(voice_files)
            if manifest["bgmLoop"]:
                inputs += ["-stream_loop", "-1", "-i", str(bgm)]
            else:
                inputs += ["-i", str(bgm)]
            filters.append(
                f"[{input_no}:a]volume={manifest['bgmVolume']:.4f},atrim=0:{total:.3f},asetpts=PTS-STARTPTS,"
                f"apad=whole_dur={total:.3f},atrim=0:{total:.3f}[bg]"
            )
            mix_labels.append("[bg]")
        if mix_labels:
            filters.append(
                "".join(mix_labels)
                + f"amix=inputs={len(mix_labels)}:duration=first:dropout_transition=0:normalize=0,"
                + f"atrim=0:{total:.3f},asetpts=PTS-STARTPTS[aout]"
            )
            run([
                ffmpeg, "-y", *inputs, "-filter_complex", ";".join(filters),
                "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-t", f"{total:.3f}", "-movflags", "+faststart", str(output),
            ])
        else:
            run([ffmpeg, "-y", "-i", str(silent), "-c", "copy", "-movflags", "+faststart", str(output)])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--assets-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--font", default=os.environ.get("MUSE_FONT_FILE", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"))
    args = parser.parse_args()
    render(args.manifest, args.assets_dir, args.output, args.font)
    print(json.dumps({"ok": True, "output": str(args.output), "bytes": args.output.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
