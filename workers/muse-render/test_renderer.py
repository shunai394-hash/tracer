import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from renderer import render, validate_manifest


def render_font() -> str:
    for candidate in (
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
        Path(r"C:\Windows\Fonts\arial.ttf"),
    ):
        if candidate.is_file():
            return str(candidate)
    return "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def band_rms_db(path: Path, frequency: int) -> float:
    completed = subprocess.run([
        "ffmpeg", "-hide_banner", "-i", str(path),
        "-af", f"bandpass=f={frequency}:width_type=h:w=30,astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    levels = []
    for line in (completed.stderr + "\n" + completed.stdout).splitlines():
        if "RMS_level=" not in line:
            continue
        try:
            levels.append(float(line.rsplit("RMS_level=", 1)[1].strip()))
        except ValueError:
            continue
    return max(levels) if levels else -120.0


class ManifestValidationTests(unittest.TestCase):
    def test_accepts_valid_manifest(self):
        result = validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": [{"title": "導入", "text": "こんにちは", "durationSeconds": 3, "motionPreset": "fade-up"}]})
        self.assertEqual(result["totalDurationSeconds"], 3.0)

    def test_rejects_unknown_preset(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": [{"durationSeconds": 3, "motionPreset": "arbitrary-code"}]})

    def test_rejects_excessive_duration(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": [{"durationSeconds": 901, "motionPreset": "fade"}]})

    def test_accepts_declared_video_background(self):
        result = validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": [{"title": "Lip sync", "text": "", "durationSeconds": 3, "motionPreset": "fade", "videoFile": "scene-1"}]})
        self.assertEqual(result["scenes"][0]["videoFile"], "scene-1")

    def test_rejects_scene_with_both_image_and_video(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": [{"title": "Invalid", "text": "", "durationSeconds": 3, "motionPreset": "fade", "imageFile": "scene-1", "videoFile": "scene-1"}]})

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for render integration test")
    def test_short_narration_does_not_shorten_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "assets"
            assets.mkdir()
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "format": "muse-motion-manifest",
                "version": 1,
                "scenes": [{
                    "title": "Test", "text": "Test",
                    "durationSeconds": 2.0, "motionPreset": "fade"
                }]
            }), encoding="utf-8")
            voice = assets / "voice-1.mp3"
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i",
                "sine=frequency=440:duration=0.4", "-q:a", "9", str(voice)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            output = root / "output.mp4"
            render(manifest_path, assets, output, render_font())
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(output)
            ], check=True, capture_output=True, text=True)
            self.assertGreaterEqual(float(probe.stdout.strip()), 1.9)


    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for render integration test")
    def test_scene_image_is_used_as_video_background(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "assets"
            assets.mkdir()
            image = assets / "scene-1.png"
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i",
                "color=c=red:s=64x64:d=1", "-frames:v", "1", str(image)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "format": "muse-motion-manifest",
                "version": 1,
                "scenes": [{
                    "title": "Image", "text": "Image",
                    "durationSeconds": 1.0, "motionPreset": "fade",
                    "imageFile": "scene-1"
                }]
            }), encoding="utf-8")
            output = root / "image-output.mp4"
            render(manifest_path, assets, output, render_font())
            frame = subprocess.run([
                "ffmpeg", "-v", "error", "-ss", "0.5", "-i", str(output), "-frames:v", "1",
                "-vf", "format=rgb24,crop=1:1:0:0", "-f", "rawvideo", "-"
            ], check=True, capture_output=True).stdout
            self.assertEqual(len(frame), 3)
            self.assertGreater(frame[0], 150)
            self.assertLess(frame[1], 100)
            self.assertLess(frame[2], 100)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe are required")
    def test_scene_video_is_used_as_background_without_source_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "assets"
            assets.mkdir()
            source = assets / "scene-1.mp4"
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i",
                "testsrc2=size=160x90:rate=24:duration=1.2",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=1.2",
                "-shortest", "-c:v", "libx264", "-c:a", "aac", str(source)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "format": "muse-motion-manifest",
                "version": 1,
                "scenes": [{
                    "title": "Lip sync clip", "text": "口パク映像",
                    "durationSeconds": 1.5, "motionPreset": "fade",
                    "videoFile": "scene-1"
                }]
            }), encoding="utf-8")
            output = root / "video-output.mp4"
            render(manifest_path, assets, output, render_font())
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries",
                "stream=codec_type:format=duration", "-of", "json", str(output)
            ], check=True, capture_output=True, text=True)
            details = json.loads(probe.stdout)
            self.assertGreaterEqual(float(details["format"]["duration"]), 1.4)
            self.assertEqual([stream["codec_type"] for stream in details["streams"]], ["video"])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe are required")
    def test_voice_and_bgm_mix_once_and_match_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "assets"
            assets.mkdir()
            source = assets / "lipsync.mp4"
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i", "color=c=green:s=160x90:r=24:d=2.2",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=2.2",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            voice = assets / "voice-1.mp3"
            bgm = assets / "bgm.mp3"
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3.0",
                "-q:a", "6", str(voice)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            subprocess.run([
                shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.4",
                "-q:a", "6", str(bgm)
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "format": "muse-motion-manifest",
                "version": 1,
                "aspect": "16:9",
                "lipsyncFile": "lipsync",
                "bgm": {"volume": 0.2, "loop": True},
                "scenes": [{
                    "title": "商品", "text": "軽くて毎日使えるマグ",
                    "durationSeconds": 1.5, "motionPreset": "fade"
                }]
            }), encoding="utf-8")
            output = root / "mixed.mp4"
            render(manifest_path, assets, output, render_font())
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration",
                "-of", "json", str(output)
            ], check=True, capture_output=True, text=True)
            details = json.loads(probe.stdout)
            self.assertGreaterEqual(float(details["format"]["duration"]), 1.4)
            self.assertLess(float(details["format"]["duration"]), 1.7)
            self.assertEqual([stream["codec_type"] for stream in details["streams"]], ["video", "audio"])
            frame = subprocess.run([
                "ffmpeg", "-v", "error", "-ss", "0.4", "-i", str(output), "-frames:v", "1",
                "-vf", "format=rgb24,crop=1:1:0:0", "-f", "rawvideo", "-"
            ], check=True, capture_output=True).stdout
            self.assertGreater(frame[1], 100)
            self.assertLess(frame[0], 80)
            self.assertLess(frame[2], 80)
            voice_level = band_rms_db(output, 440)
            bgm_level = band_rms_db(output, 220)
            leaked = band_rms_db(output, 880)
            self.assertGreater(voice_level, -45)
            self.assertGreater(bgm_level, -50)
            self.assertLess(leaked, voice_level - 12)

    def test_rejects_empty_scenes(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": []})


if __name__ == "__main__":
    unittest.main()
