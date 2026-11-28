#!/usr/bin/env python3
"""Sequential Colab worker for the TRACER Muse MP4 render queue.

Run one process per Colab runtime. It claims one job at a time and never starts
parallel FFmpeg renders. The worker token is supplied via environment/CLI and
is never written to disk.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from renderer import render

USER_AGENT = "TRACER-Muse-Render-Worker/1.0"


def request_json(url: str, token: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "worker_api_failed"))
    return result


def download(url: str, destination: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError(f"Downloaded asset is empty: {destination.name}")


def upload(url: str, token: str, source: Path) -> None:
    # Supabase signed-upload URL authorizes the upload; token is retained in
    # the response for SDK compatibility and is not the worker secret.
    req = urllib.request.Request(
        url, data=source.read_bytes(), method="POST",
        headers={"Content-Type": "video/mp4", "x-upsert": "true", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=300) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"MP4 upload failed: HTTP {response.status}")


def process_job(api: str, worker_token: str, job: dict, font: str) -> None:
    job_id = job["id"]
    lease_token = job["leaseToken"]
    with tempfile.TemporaryDirectory(prefix=f"muse-{job_id[:8]}-") as tmp:
        root = Path(tmp)
        assets_dir = root / "assets"
        assets_dir.mkdir()
        for asset in job.get("assets", []):
            relative = Path(asset["path"])
            if relative.is_absolute() or ".." in relative.parts or len(relative.parts) != 1:
                raise RuntimeError("Unsafe asset path from queue")
            download(asset["url"], assets_dir / relative.name)

        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(job["manifest"], ensure_ascii=False), encoding="utf-8")
        output_path = root / "render.mp4"
        render(manifest_path, assets_dir, output_path, font)
        if output_path.stat().st_size < 1024:
            raise RuntimeError("Rendered MP4 is unexpectedly small")
        upload(job["output"]["url"], job["output"]["token"], output_path)

    # Completion is reported by main after the heartbeat thread is stopped.


def heartbeat_loop(api: str, token: str, job_id: str, lease_token: str, stop: threading.Event) -> None:
    while not stop.wait(240):
        try:
            request_json(api, token, {
                "action": "heartbeat", "id": job_id, "leaseToken": lease_token,
            })
            print(f"Lease renewed for {job_id}", flush=True)
        except Exception as exc:
            print(f"Lease heartbeat failed for {job_id}: {exc}", flush=True)
            # Do not silently continue as if ownership were guaranteed.
            return


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=os.environ.get("TRACER_BASE_URL", ""))
    parser.add_argument("--token", default=os.environ.get("MUSE_RENDER_WORKER_TOKEN", ""))
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--once", action="store_true", help="Claim at most one job, then exit")
    parser.add_argument("--font", default=os.environ.get("MUSE_FONT_FILE", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"))
    args = parser.parse_args()
    if not args.base_url or not args.token:
        parser.error("Set --base-url and --token (or TRACER_BASE_URL / MUSE_RENDER_WORKER_TOKEN)")
    api = args.base_url.rstrip("/") + "/api/admin/ai-live/muse-render/worker"
    if shutil.which("ffmpeg") is None:
        parser.error("FFmpeg is not installed. In Colab run: !apt-get -qq update && !apt-get -qq install -y ffmpeg fonts-noto-cjk")

    print("Muse worker started: sequential mode (one render at a time)", flush=True)
    while True:
        try:
            response = request_json(api, args.token, {"action": "claim"})
            job = response.get("job")
            if not job:
                if args.once:
                    return 0
                time.sleep(max(2, args.poll_seconds))
                continue
            print(f"Claimed {job['id']} (attempt {job.get('attempt', '?')})", flush=True)
            stop_heartbeat = threading.Event()
            heartbeat = threading.Thread(
                target=heartbeat_loop,
                args=(api, args.token, job["id"], job["leaseToken"], stop_heartbeat),
                daemon=True,
            )
            heartbeat.start()
            try:
                process_job(api, args.token, job, args.font)
                stop_heartbeat.set()
                heartbeat.join(timeout=5)
                request_json(api, args.token, {
                    "action": "complete", "id": job["id"], "leaseToken": job["leaseToken"],
                    "succeeded": True,
                })
                print(f"Completed {job['id']}", flush=True)
            except Exception as exc:
                stop_heartbeat.set()
                heartbeat.join(timeout=5)
                message = str(exc)[:900]
                print(f"Failed {job['id']}: {message}", flush=True)
                try:
                    request_json(api, args.token, {
                        "action": "complete", "id": job["id"], "leaseToken": job["leaseToken"],
                        "succeeded": False, "error": message,
                    })
                except Exception as completion_error:
                    print(f"Could not report failure: {completion_error}", flush=True)
            if args.once:
                return 0
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            print(f"Worker API HTTP {exc.code}: {detail}", flush=True)
            if args.once:
                return 1
            time.sleep(max(5, args.poll_seconds))
        except Exception as exc:
            print(f"Worker loop error: {exc}", flush=True)
            if args.once:
                return 1
            time.sleep(max(5, args.poll_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
