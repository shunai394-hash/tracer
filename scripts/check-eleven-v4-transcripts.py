#!/usr/bin/env python3
"""Transcribe generated Japanese clips and compare them with their source lines.

Requires: pip install faster-whisper
Default model is 'base' with CPU int8 to fit modest Windows PCs.
This tool never regenerates audio or sends network requests beyond model download
performed by faster-whisper on first use.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


def normalize_japanese(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(ch for ch in value if not ch.isspace() and not unicodedata.category(ch).startswith("P"))


def similarity(expected: str, actual: str) -> float:
    left, right = normalize_japanese(expected), normalize_japanese(actual)
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def run_self_test() -> None:
    assert normalize_japanese("今日は、 おすすめ！") == normalize_japanese("今日はおすすめ")
    assert similarity("こんにちは。今日は商品をご紹介します。", "こんにちは今日は商品をご紹介します") > 0.95
    assert similarity("正しい読みです", "まったく違う内容です") < 0.6
    print("Japanese transcript comparison self-test passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Eleven v4 MP3 clips against their Japanese script.")
    parser.add_argument("--input-json", type=Path, help="JSON array with id and text fields")
    parser.add_argument("--audio-dir", type=Path, default=Path("artifacts/eleven-v4"))
    parser.add_argument("--report", type=Path, default=Path("artifacts/eleven-v4/transcription-report.json"))
    parser.add_argument("--model", default="base", help="faster-whisper model size (default: base)")
    parser.add_argument("--threshold", type=float, default=0.88, help="similarity threshold for review (default: 0.88)")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0
    if args.input_json is None:
        parser.error("--input-json is required unless --self-test is used")
    if not 0.0 <= args.threshold <= 1.0:
        parser.error("--threshold must be between 0 and 1")

    try:
        clips: Any = json.loads(args.input_json.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Cannot read input JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(clips, list) or not clips:
        print("Input JSON must be a non-empty array.", file=sys.stderr)
        return 2

    seen: set[str] = set()
    for item in clips:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str):
            print("Each input item must contain string id and text fields.", file=sys.stderr)
            return 2
        clip_id = item["id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", clip_id) or clip_id in seen:
            print(f"Invalid or duplicate clip id: {clip_id!r}", file=sys.stderr)
            return 2
        if not item["text"].strip():
            print(f"Empty source text for clip {clip_id}.", file=sys.stderr)
            return 2
        seen.add(clip_id)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is missing. Install with: py -m pip install faster-whisper", file=sys.stderr)
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as exc:
        print(f"Could not initialize faster-whisper model: {exc}", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []
    for item in clips:
        clip_id, expected = item["id"], item["text"]
        audio_path = args.audio_dir / f"{clip_id}.mp3"
        if not audio_path.is_file():
            results.append({
                "id": clip_id, "audio": str(audio_path), "status": "MISSING_AUDIO",
                "expected": expected, "transcript": "", "similarity": 0.0,
            })
            continue
        try:
            segments, info = model.transcribe(
                str(audio_path), language="ja", beam_size=5, vad_filter=True
            )
            transcript = "".join(segment.text for segment in segments).strip()
            score = similarity(expected, transcript)
            status = "PASS" if transcript and score >= args.threshold else "REVIEW"
            results.append({
                "id": clip_id,
                "audio": str(audio_path),
                "status": status,
                "expected": expected,
                "transcript": transcript,
                "similarity": round(score, 4),
                "language": info.language,
            })
            print(f"{clip_id}: {status} ({score:.1%})")
        except Exception as exc:
            results.append({
                "id": clip_id, "audio": str(audio_path), "status": "TRANSCRIPTION_ERROR",
                "expected": expected, "transcript": "", "similarity": 0.0,
                "error": str(exc)[:240],
            })
            print(f"{clip_id}: TRANSCRIPTION_ERROR", file=sys.stderr)

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    review_count = sum(row["status"] != "PASS" for row in results)
    print(f"Report: {args.report}")
    print(f"Passed: {len(results) - review_count}/{len(results)}; needs review: {review_count}")
    print("PASS is an automated similarity screen, not a guarantee of correct pronunciation. Listen to every clip before use.")
    return 1 if review_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
