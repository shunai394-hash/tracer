import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from renderer import render, validate_manifest


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
            render(manifest_path, assets, output, "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
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
            render(manifest_path, assets, output, "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
            frame = subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(output), "-frames:v", "1",
                "-vf", "crop=1:1:0:0,format=rgb24", "-f", "rawvideo", "-"
            ], check=True, capture_output=True).stdout
            self.assertEqual(len(frame), 3)
            self.assertGreater(frame[0], 150)
            self.assertLess(frame[1], 100)
            self.assertLess(frame[2], 100)

    def test_rejects_empty_scenes(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": []})


if __name__ == "__main__":
    unittest.main()
