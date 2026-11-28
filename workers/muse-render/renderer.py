#!/usr/bin/env python3
"""Render a validated Muse motion manifest to MP4 with FFmpeg.

This worker is deliberately local-file-only. The queue adapter must download
approved Supabase assets into an isolated job directory before invoking it.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

PRESETS = {"fade-up", "soft-zoom", "slide-left", "pop", "fade"}
MAX_SCENES = 120
MAX_DURATION = 60.0
MAX_TOTAL = 900.0


def validate_manifest(data: object) -> dict:
    if not isinstance(data, dict) or data.get("format") != "muse-motion-manifest" or data.get("version") != 1:
        raise ValueError("Unsupported Muse motion manifest")
    scenes = data.get("scenes")
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= MAX_SCENES:
        raise ValueError("Manifest must contain 1..120 scenes")
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
        clean.append({"title": title, "text": text, "durationSeconds": float(duration), "motionPreset": preset})
        total += float(duration)
    if total > MAX_TOTAL:
        raise ValueError("Total duration exceeds 15 minutes")
    return {"scenes": clean, "totalDurationSeconds": total, "fps": 30}


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def drawtext_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%").replace(",", "\\,").replace("[", "\\[").replace("]", "\\]")


def render(manifest_path: Path, assets_dir: Path, output: Path, font: str) -> None:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = validate_manifest(data)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required")
    assets_dir = assets_dir.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="muse-render-") as temp:
        tempdir = Path(temp)
        clips = []
        offset = 0.0
        for index, scene in enumerate(manifest["scenes"]):
            duration = scene["durationSeconds"]
            clip = tempdir / f"scene-{index:03d}.mp4"
            text = drawtext_escape(scene["text"] or scene["title"])
            # Motion is intentionally restrained for a readable first renderer.
            if scene["motionPreset"] == "slide-left":
                x_expr = "if(lt(t,0.5),960-960*t/0.5,0)"
            elif scene["motionPreset"] == "fade-up":
                x_expr = "0"
            else:
                x_expr = "0"
            vf = f"drawtext=fontfile='{font}':text='{text}':fontcolor=white:fontsize=68:borderw=3:bordercolor=black@0.65:x=(w-text_w)/2+({x_expr}):y=(h-text_h)/2:enable='between(t,0,{duration})',fade=t=in:st=0:d=0.35,fade=t=out:st={max(0,duration-0.35)}:d=0.35,format=yuv420p"
            run([ffmpeg, "-y", "-f", "lavfi", "-i", f"color=c=0x101827:s=1920x1080:r=30:d={duration}", "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(clip)])
            clips.append(clip)
            offset += duration
        concat = tempdir / "concat.txt"
        concat.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips), encoding="utf-8")
        silent = tempdir / "silent.mp4"
        run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(silent)])

        voice_files = []
        for index in range(len(manifest["scenes"])):
            candidate = (assets_dir / f"voice-{index + 1}.mp3").resolve()
            if candidate.exists() and candidate.is_file() and assets_dir in candidate.parents:
                voice_files.append((index, candidate))
        bgm = (assets_dir / "bgm.mp3").resolve()
        inputs = ["-i", str(silent)]
        filters = []
        mix_labels = []
        for ordinal, (index, path) in enumerate(voice_files):
            input_no = ordinal + 1
            inputs += ["-i", str(path)]
            start = sum(s["durationSeconds"] for s in manifest["scenes"][:index])
            label = f"v{index}"
            filters.append(f"[{input_no}:a]adelay={int(start*1000)}|{int(start*1000)},volume=1.0[{label}]")
            mix_labels.append(f"[{label}]")
        has_bgm = bgm.exists() and bgm.is_file() and assets_dir in bgm.parents
        if has_bgm:
            input_no = 1 + len(voice_files)
            inputs += ["-stream_loop", "-1", "-i", str(bgm)]
            filters.append(f"[{input_no}:a]volume=0.18,atrim=0:{manifest['totalDurationSeconds']}[bg]")
            mix_labels.append("[bg]")
        if mix_labels:
            filters.append("".join(mix_labels) + f"amix=inputs={len(mix_labels)}:duration=longest:normalize=0[aout]")
            run([ffmpeg, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(output)])
        else:
            shutil.copy2(silent, output)


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
