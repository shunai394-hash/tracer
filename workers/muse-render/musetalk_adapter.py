#!/usr/bin/env python3
"""Connect an optional MuseTalk 1.5 checkout to the existing FFmpeg render queue.

MuseTalk is not bundled and is not executed unless a job asks for it and the
Colab GPU runtime already has the upstream checkout and weights. This module
never downloads weights and never reports success when inference did not run.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")


class MuseTalkNotExecuted(RuntimeError):
    """Raised when lip-sync was requested but MuseTalk did not produce a video."""


def probe_gpu() -> dict:
    nvidia = shutil.which("nvidia-smi")
    if not nvidia:
        return {"available": False, "name": "", "memoryMiB": 0}
    completed = subprocess.run(
        [nvidia, "--query-gpu=name,memory.total", "--format=csv,noheader"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20,
    )
    if completed.returncode != 0:
        return {"available": False, "name": "", "memoryMiB": 0}
    line = completed.stdout.strip().splitlines()[0] if completed.stdout.strip() else ""
    name, _, memory = line.partition(",")
    digits = "".join(ch for ch in memory if ch.isdigit())
    return {"available": True, "name": name.strip(), "memoryMiB": int(digits or "0")}


def musetalk_root() -> Path | None:
    raw = os.environ.get("MUSE_TALK_ROOT", "").strip()
    if not raw:
        return None
    root = Path(raw)
    return root if root.is_dir() else None


def readiness(root: Path | None = None, gpu: dict | None = None) -> dict:
    root = musetalk_root() if root is None else root
    gpu = probe_gpu() if gpu is None else gpu
    reasons: list[str] = []
    if not gpu.get("available"):
        reasons.append("NVIDIA GPU was not detected")
    if root is None:
        reasons.append("MUSE_TALK_ROOT is not a MuseTalk checkout")
    else:
        if not (root / "scripts" / "inference.py").is_file():
            reasons.append("scripts/inference.py is missing")
        if not (root / "models" / "musetalkV15" / "unet.pth").is_file():
            reasons.append("models/musetalkV15/unet.pth is missing")
        if not (root / "models" / "musetalkV15" / "musetalk.json").is_file():
            reasons.append("models/musetalkV15/musetalk.json is missing")
    return {"ready": not reasons, "reasons": reasons, "gpu": gpu, "executed": False}


def _find_face(assets_dir: Path) -> Path | None:
    for name in ("scene-1", "face", "portrait"):
        for extension in IMAGE_EXTENSIONS:
            candidate = assets_dir / f"{name}{extension}"
            if candidate.is_file():
                return candidate
    return None


def _find_audio(assets_dir: Path) -> Path | None:
    for name in ("narration.mp3", "voice-1.mp3"):
        candidate = assets_dir / name
        if candidate.is_file():
            return candidate
    return None


def _existing_lipsync(assets_dir: Path) -> Path | None:
    for extension in (".mp4", ".webm"):
        candidate = assets_dir / f"lipsync{extension}"
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return None


def attach_musetalk_video(manifest: dict, assets_dir: Path, runner=None) -> None:
    """Produce lipsync.mp4 when this job explicitly asks the shared queue for MuseTalk."""
    request = manifest.get("lipSync")
    if not isinstance(request, dict) or request.get("engine") != "musetalk":
        return
    if _existing_lipsync(assets_dir) is not None:
        manifest["lipsyncFile"] = "lipsync"
        return
    face = _find_face(assets_dir)
    audio = _find_audio(assets_dir)
    if face is None or audio is None:
        raise MuseTalkNotExecuted("MuseTalk was not executed: a portrait image and Fish dialogue audio are required")
    output = assets_dir / "lipsync.mp4"
    generate_lipsync(face, audio, output, runner=runner)
    manifest["lipsyncFile"] = "lipsync"


def generate_lipsync(face: Path, audio: Path, output: Path, root: Path | None = None, runner=None, gpu: dict | None = None) -> None:
    root = musetalk_root() if root is None else root
    report = readiness(root, gpu)
    if not report["ready"] or root is None:
        reason = "; ".join(report["reasons"]) or "MuseTalk is not ready"
        raise MuseTalkNotExecuted(f"MuseTalk was not executed: {reason}")
    work = output.parent / "musetalk-job"
    work.mkdir(parents=True, exist_ok=True)
    config = work / "inference.yaml"
    config.write_text(
        f'task_0:\n  video_path: "{face.resolve().as_posix()}"\n  audio_path: "{audio.resolve().as_posix()}"\n',
        encoding="utf-8",
    )
    result_dir = work / "results"
    command = [
        sys.executable, "-m", "scripts.inference",
        "--inference_config", str(config),
        "--result_dir", str(result_dir),
        "--unet_model_path", str(root / "models" / "musetalkV15" / "unet.pth"),
        "--unet_config", str(root / "models" / "musetalkV15" / "musetalk.json"),
        "--version", "v15",
    ]
    run = runner or subprocess.run
    completed = run(command, cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-800:]
        raise MuseTalkNotExecuted(f"MuseTalk was not executed successfully: {detail or 'inference failed'}")
    produced = sorted(result_dir.rglob("*.mp4"), key=lambda path: path.stat().st_mtime)
    if not produced:
        raise MuseTalkNotExecuted("MuseTalk was not executed successfully: inference returned no MP4")
    shutil.copy2(produced[-1], output)
    if not output.is_file() or output.stat().st_size < 1024:
        raise MuseTalkNotExecuted("MuseTalk was not executed successfully: output MP4 is empty")
