#!/usr/bin/env python3
"""Local-only MoneyPrinterTurbo studio for TRACER.

This bridge intentionally uses only uploaded local media and the official MPT CLI.
It never selects an online footage/video-generation provider and never auto-publishes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import uuid
import webbrowser
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

MAX_REQUEST_BYTES = 185 * 1024 * 1024
MAX_FILE_BYTES = 60 * 1024 * 1024
MAX_FILES = 8
MAX_SCRIPT_CHARS = 12_000
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
VOICES = {"ja-JP-NanamiNeural", "ja-JP-KeitaNeural", "no-voice"}
ASPECTS = {"9:16", "16:9", "1:1"}

TASKS: dict[str, dict[str, Any]] = {}
TASKS_LOCK = threading.RLock()
ACTIVE_TASK: str | None = None
ACTIVE_LOCK = threading.Lock()
SERVER: ThreadingHTTPServer | None = None
DATA_DIR: Path
MPT_EXE: Path
PORT: int


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def load_or_create_config(data_dir: Path, mpt_exe: Path) -> None:
    config_path = data_dir / "config.toml"
    if not config_path.exists():
        # Resolve the template from the same isolated venv as mpt.exe, not from
        # this bridge's interpreter. The bridge itself uses only Python stdlib.
        venv_root = mpt_exe.parent.parent
        template = venv_root / "Lib" / "site-packages" / "app" / "_assets" / "config.example.toml"
        if not template.is_file():
            raise RuntimeError(
                "MoneyPrinterTurboの初期設定ファイルが見つかりません。"
                "mpt==1.3.9のインストール先を確認してください。"
            )
        config_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(template, config_path)

    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise RuntimeError(f"MoneyPrinterTurboのconfig.tomlを読み込めません: {exc}") from exc

    if config.get("upload_post_enabled") is True or config.get("upload_post_auto_upload") is True:
        raise RuntimeError(
            "安全のため自動投稿設定が有効なMPT設定では起動しません。"
            "このローカル制作環境専用の新しいデータフォルダを使ってください。"
        )


def safe_child_environment(data_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["MPT_HOME"] = str(data_dir)
    env["PYTHONUTF8"] = "1"
    # This workflow uses --video-source local and Edge TTS only. Do not let
    # unrelated shell credentials activate paid or remote providers.
    blocked_fragments = (
        "PEXELS", "PIXABAY", "COVERR", "WAVESPEED", "SEEDANCE",
        "VOLCENGINE", "OFOX", "METASO", "MUAPI", "INFISTAR",
        "JALAPENO", "SONILO", "ELEVENLABS", "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FISH_API_KEY",
        "MINIMAX_API_KEY", "AZURE_SPEECH_KEY",
    )
    for key in list(env):
        upper = key.upper()
        if any(fragment in upper for fragment in blocked_fragments):
            env.pop(key, None)
    return env


def write_manifest(task_id: str, task: dict[str, Any]) -> None:
    manifest_dir = DATA_DIR / "studio" / "tasks"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    target = manifest_dir / f"{task_id}.json"
    temp = target.with_suffix(".json.tmp")
    safe = {key: value for key, value in task.items() if key not in {"command", "thread"}}
    temp.write_text(json.dumps(safe, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(target)


def cleanup_task_inputs(task: dict[str, Any]) -> None:
    """Remove this task's uploaded inputs without touching other MPT files."""
    local_root = (DATA_DIR / "storage" / "local_videos").resolve()
    input_dir_value = task.get("input_dir")
    if input_dir_value:
        candidate = Path(input_dir_value).resolve()
        if candidate.parent == local_root and candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)

    bgm_root = (DATA_DIR / "storage" / "bgm").resolve()
    bgm_path_value = task.get("bgm_path")
    if bgm_path_value:
        candidate_bgm = Path(bgm_path_value).resolve()
        if candidate_bgm.parent == bgm_root and candidate_bgm.is_file():
            candidate_bgm.unlink(missing_ok=True)


def update_task(task_id: str, **changes: Any) -> None:
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return
        task.update(changes)
        task["updated_at"] = utc_now()
        write_manifest(task_id, task)


def create_cli_command(
    mpt_exe: Path,
    task_id: str,
    title: str,
    script: str,
    asset_paths: list[Path],
    voice: str,
    aspect: str,
    clip_duration: int,
    subtitles: bool,
    bgm_filename: str | None,
) -> list[str]:
    command = [
        str(mpt_exe), "cli",
        "--video-subject", title,
        "--video-script", script,
        "--video-language", "ja-JP",
        "--video-source", "local",
        "--video-materials", ",".join(str(path.resolve()) for path in asset_paths),
        "--video-aspect", aspect,
        "--video-fit-mode", "cover",
        "--video-concat-mode", "sequential",
        "--video-clip-duration", str(clip_duration),
        "--video-clip-speed", "1",
        "--video-transition-mode", "fade-in",
        "--n-threads", "1",
        "--voice-name", voice,
        "--voice-volume", "1",
        "--voice-rate", "1",
        "--bgm-type", "custom" if bgm_filename else "none",
        "--bgm-volume", "0.15",
        "--subtitle-position", "bottom",
        "--stop-at", "video",
        "--task-id", task_id,
    ]
    if subtitles:
        command.append("--subtitle-enabled")
    else:
        command.append("--no-subtitle-enabled")
    if bgm_filename:
        command.extend(["--bgm-file", bgm_filename])
    return command


def run_generation(
    task_id: str,
    command: list[str],
    output_dir: Path,
    log_path: Path,
) -> None:
    global ACTIVE_TASK
    update_task(task_id, status="running", message="MoneyPrinterTurboで動画を編集中です。", started_at=utc_now())
    env = safe_child_environment(DATA_DIR)
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log_file:
            completed = subprocess.run(
                command,
                cwd=DATA_DIR,
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                timeout=3600,
                check=False,
            )
        if completed.returncode != 0:
            tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
            detail = "\n".join(tail)[-3000:]
            update_task(
                task_id,
                status="failed",
                message="動画の編集に失敗しました。ログを確認してください。",
                error=detail or f"MoneyPrinterTurbo exited with code {completed.returncode}.",
                finished_at=utc_now(),
            )
            return

        videos = sorted(
            path for path in output_dir.glob("final-*.mp4")
            if path.is_file() and path.stat().st_size > 0
        )
        if not videos:
            update_task(
                task_id,
                status="failed",
                message="処理は終了しましたが、完成MP4が見つかりません。",
                error="MoneyPrinterTurbo did not produce a non-empty final-*.mp4 file.",
                finished_at=utc_now(),
            )
            return

        selected = videos[0]
        update_task(
            task_id,
            status="completed",
            message="MP4が完成しました。",
            video_name=selected.name,
            video_size=selected.stat().st_size,
            video_url=f"/api/tasks/{task_id}/video",
            finished_at=utc_now(),
        )
    except subprocess.TimeoutExpired:
        update_task(
            task_id,
            status="failed",
            message="処理が60分でタイムアウトしました。",
            error="The local rendering process exceeded 3600 seconds.",
            finished_at=utc_now(),
        )
    except OSError as exc:
        update_task(
            task_id,
            status="failed",
            message="MoneyPrinterTurboを起動できませんでした。",
            error=str(exc),
            finished_at=utc_now(),
        )
    finally:
        # MPT's local video source accepts files only from storage/local_videos.
        # Remove this task's private subdirectory after the CLI has stopped.
        with TASKS_LOCK:
            task = dict(TASKS.get(task_id, {}))
        cleanup_task_inputs(task)
        with ACTIVE_LOCK:
            if ACTIVE_TASK == task_id:
                ACTIVE_TASK = None


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], list[tuple[str, bytes]], tuple[str, bytes] | None]:
    header = (
        f"Content-Type: {content_type}\r\n"
        "MIME-Version: 1.0\r\n\r\n"
    ).encode("ascii", errors="strict") + body
    message = BytesParser(policy=policy.default).parsebytes(header)
    if not message.is_multipart():
        raise ValueError("フォームデータを読み取れませんでした。")
    fields: dict[str, str] = {}
    assets: list[tuple[str, bytes]] = []
    bgm: tuple[str, bytes] | None = None

    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename:
            if not payload:
                continue
            if len(payload) > MAX_FILE_BYTES:
                raise ValueError("1ファイルは60MB以下にしてください。")
            if name == "assets":
                assets.append((filename, payload))
            elif name == "bgm":
                bgm = (filename, payload)
        elif name:
            charset = part.get_content_charset() or "utf-8"
            fields[str(name)] = payload.decode(charset, errors="replace")
    return fields, assets, bgm


def safe_extension(filename: str, allowed: set[str]) -> str:
    ext = Path(filename.replace("\\", "/")).suffix.lower()
    if ext not in allowed:
        raise ValueError(f"対応していないファイル形式です: {ext or '拡張子なし'}")
    return ext


class Handler(BaseHTTPRequestHandler):
    server_version = "TRACER-MPT-Local/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs free of form bodies, prompts, uploaded filenames, and tokens.
        sys.stdout.write(f"[MPT Local] {self.log_date_time_string()} {fmt % args}\n")

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in {
            f"127.0.0.1:{PORT}",
            f"localhost:{PORT}",
        }

    def _send(self, status: int, payload: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json_bytes(value), "application/json; charset=utf-8")

    def _origin_ok(self) -> bool:
        return self.headers.get("Origin", "") == f"http://127.0.0.1:{PORT}"

    def do_GET(self) -> None:
        if not self._host_ok() or not self.client_address[0].startswith("127."):
            self._json(403, {"error": "このローカル制作画面からのみアクセスできます。"})
            return

        parsed = urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            page_path = Path(__file__).resolve().parent.parent / "public" / "mpt-local-studio.html"
            if not page_path.is_file():
                self._json(500, {"error": "制作画面ファイルが見つかりません。"})
                return
            page = page_path.read_bytes()
            self._send(
                200,
                page,
                "text/html; charset=utf-8",
                {"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:"},
            )
            return

        if parsed.path == "/api/health":
            self._json(200, {
                "ready": True,
                "engine": "MoneyPrinterTurbo",
                "engine_version": "1.3.9",
                "mode": "local-assets-only",
                "max_upload_bytes": MAX_REQUEST_BYTES,
            })
            return

        match = re.fullmatch(r"/api/tasks/([0-9a-f-]{36})", parsed.path)
        if match:
            with TASKS_LOCK:
                task = TASKS.get(match.group(1))
                if task:
                    public_task = {key: value for key, value in task.items() if key not in {"error", "input_dir", "log_path"}}
                    self._json(200, public_task)
                else:
                    self._json(404, {"error": "タスクが見つかりません。"})
            return

        video_match = re.fullmatch(r"/api/tasks/([0-9a-f-]{36})/video", parsed.path)
        if video_match:
            task_id = video_match.group(1)
            with TASKS_LOCK:
                task = TASKS.get(task_id)
                video_name = task.get("video_name") if task else None
            if not video_name or not re.fullmatch(r"final-[0-9]+\.mp4", video_name):
                self._json(404, {"error": "完成動画がまだありません。"})
                return
            video_path = DATA_DIR / "storage" / "tasks" / task_id / video_name
            if not video_path.is_file():
                self._json(404, {"error": "完成動画ファイルが見つかりません。"})
                return
            try:
                size = video_path.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", f'inline; filename="{video_name}"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                with video_path.open("rb") as source:
                    shutil.copyfileobj(source, self.wfile, length=1024 * 1024)
            except (OSError, BrokenPipeError):
                return
            return

        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if (
            not self._host_ok()
            or not self.client_address[0].startswith("127.")
            or not self._origin_ok()
        ):
            self._json(403, {"error": "外部サイトからの操作は許可されていません。"})
            return

        if urlparse(self.path).path != "/api/tasks":
            self._json(404, {"error": "Not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data;"):
            self._json(415, {"error": "ファイル付きフォームで送信してください。"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length < 1 or content_length > MAX_REQUEST_BYTES:
            self._json(413, {"error": "アップロード合計サイズは180MB以下にしてください。"})
            return

        with ACTIVE_LOCK:
            global ACTIVE_TASK
            if ACTIVE_TASK:
                self._json(409, {"error": "別の動画を編集中です。完了してから次を開始してください。"})
                return

            try:
                body = self.rfile.read(content_length)
                fields, uploads, bgm_upload = parse_multipart(content_type, body)
                title = fields.get("title", "").strip()[:160]
                script = fields.get("script", "").strip()
                voice = fields.get("voice", "ja-JP-NanamiNeural").strip()
                aspect = fields.get("aspect", "9:16").strip()
                try:
                    clip_duration = int(fields.get("clip_duration", "5"))
                except ValueError as exc:
                    raise ValueError("1カットの長さは整数で指定してください。") from exc
                subtitles = fields.get("subtitles", "true").lower() == "true"

                if not title:
                    raise ValueError("動画タイトルを入力してください。")
                if not script or len(script) > MAX_SCRIPT_CHARS:
                    raise ValueError("台本は1文字以上12,000文字以内で入力してください。")
                if voice not in VOICES:
                    raise ValueError("音声設定が不正です。")
                if aspect not in ASPECTS:
                    raise ValueError("画面比率が不正です。")
                if not 1 <= clip_duration <= 15:
                    raise ValueError("1カットの長さは1〜15秒で指定してください。")
                if not uploads:
                    raise ValueError("動画または画像素材を1つ以上アップロードしてください。")
                if len(uploads) > MAX_FILES:
                    raise ValueError("素材は最大8ファイルまでです。")

                task_id = str(uuid.uuid4())
                input_dir = DATA_DIR / "storage" / "local_videos" / task_id
                input_dir.mkdir(parents=True, exist_ok=False)
                asset_paths: list[Path] = []

                for index, (original_name, payload) in enumerate(uploads, start=1):
                    ext = safe_extension(original_name, VIDEO_EXTENSIONS | IMAGE_EXTENSIONS)
                    target = input_dir / f"asset-{index:02d}{ext}"
                    target.write_bytes(payload)
                    asset_paths.append(target)

                bgm_filename: str | None = None
                if bgm_upload:
                    bgm_ext = safe_extension(bgm_upload[0], AUDIO_EXTENSIONS)
                    bgm_filename = f"studio-bgm-{task_id}{bgm_ext}"
                    bgm_dir = DATA_DIR / "storage" / "bgm"
                    bgm_dir.mkdir(parents=True, exist_ok=True)
                    (bgm_dir / bgm_filename).write_bytes(bgm_upload[1])

                output_dir = DATA_DIR / "storage" / "tasks" / task_id
                log_dir = DATA_DIR / "studio" / "logs"
                log_dir.mkdir(parents=True, exist_ok=True)
                log_path = log_dir / f"{task_id}.log"
                command = create_cli_command(
                    MPT_EXE, task_id, title, script, asset_paths, voice, aspect,
                    clip_duration, subtitles, bgm_filename,
                )
                task = {
                    "id": task_id,
                    "status": "queued",
                    "message": "動画制作を受け付けました。",
                    "title": title,
                    "created_at": utc_now(),
                    "updated_at": utc_now(),
                    "input_dir": str(input_dir),
                    "bgm_path": str((DATA_DIR / "storage" / "bgm" / bgm_filename).resolve()) if bgm_filename else None,
                    "log_path": str(log_path),
                }
                with TASKS_LOCK:
                    TASKS[task_id] = task
                    write_manifest(task_id, task)
                ACTIVE_TASK = task_id
                thread = threading.Thread(
                    target=run_generation,
                    args=(task_id, command, output_dir, log_path),
                    daemon=True,
                    name=f"mpt-{task_id[:8]}",
                )
                thread.start()
                self._json(202, {"task_id": task_id, "status": "queued"})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except Exception as exc:
                self._json(500, {"error": f"ローカル制作サーバーでエラーが発生しました: {exc}"})

    def do_OPTIONS(self) -> None:
        self._json(405, {"error": "CORSは無効です。ローカル制作画面から操作してください。"})


def main() -> int:
    parser = argparse.ArgumentParser(description="TRACER local MoneyPrinterTurbo studio")
    parser.add_argument("--mpt-exe", required=True, help="Path to the official mpt.exe launcher")
    parser.add_argument("--data-dir", required=True, help="Dedicated MPT_HOME directory")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    global DATA_DIR, MPT_EXE, PORT, SERVER
    MPT_EXE = Path(args.mpt_exe).expanduser().resolve()
    DATA_DIR = Path(args.data_dir).expanduser().resolve()
    PORT = args.port

    if not MPT_EXE.is_file():
        print("ERROR: mpt.exe not found. Run scripts/setup-mpt-local-studio.ps1 first.", file=sys.stderr)
        return 2
    if not 1024 <= PORT <= 65535:
        print("ERROR: port must be between 1024 and 65535.", file=sys.stderr)
        return 2

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        load_or_create_config(DATA_DIR, MPT_EXE)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    # Recover task manifests for read-only history after a local server restart.
    manifest_dir = DATA_DIR / "studio" / "tasks"
    if manifest_dir.is_dir():
        for manifest in manifest_dir.glob("*.json"):
            try:
                task = json.loads(manifest.read_text(encoding="utf-8"))
                if task.get("status") in {"queued", "running"}:
                    task["status"] = "interrupted"
                    task["message"] = "ローカルサーバーの停止により処理が中断されました。"
                    task["updated_at"] = utc_now()
                    manifest.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
                TASKS[task["id"]] = task
                cleanup_task_inputs(task)
            except (OSError, ValueError, KeyError, TypeError):
                continue

    address = f"http://127.0.0.1:{PORT}/"
    try:
        SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        print(f"ERROR: http://127.0.0.1:{PORT} を使用できません: {exc}", file=sys.stderr)
        return 2

    print(f"TRACER MoneyPrinterTurbo Studio: {address}")
    print("Local-only mode: uploaded footage/images + script; no paid video API or auto-publishing.")
    print("Stop with Ctrl+C.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(address)).start()

    try:
        SERVER.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopping local studio...")
    finally:
        SERVER.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
