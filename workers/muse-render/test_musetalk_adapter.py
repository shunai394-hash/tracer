import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from musetalk_adapter import MuseTalkNotExecuted, attach_musetalk_video, generate_lipsync, readiness


class MuseTalkAdapterTests(unittest.TestCase):
    def test_missing_checkout_is_not_executed(self):
        report = readiness(Path("/missing/MuseTalk"), {"available": True, "name": "Tesla T4", "memoryMiB": 15360})
        self.assertFalse(report["ready"])
        self.assertFalse(report["executed"])
        self.assertTrue(any("checkout" in reason or "inference.py" in reason for reason in report["reasons"]))

    def test_generate_refuses_without_weights(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "inference.py").write_text("# upstream entry\n", encoding="utf-8")
            with self.assertRaises(MuseTalkNotExecuted) as caught:
                generate_lipsync(root / "face.png", root / "voice.mp3", root / "lipsync.mp4", root=root)
        self.assertIn("was not executed", str(caught.exception))

    def test_ready_checkout_uses_v15_inference_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "MuseTalk"
            (root / "scripts").mkdir(parents=True)
            (root / "models" / "musetalkV15").mkdir(parents=True)
            (root / "scripts" / "inference.py").write_text("# upstream entry\n", encoding="utf-8")
            (root / "models" / "musetalkV15" / "unet.pth").write_bytes(b"weights")
            (root / "models" / "musetalkV15" / "musetalk.json").write_text("{}", encoding="utf-8")
            calls = []

            def runner(command, cwd, stdout, stderr, text):
                calls.append((command, cwd))
                result_dir = Path(command[command.index("--result_dir") + 1])
                result_dir.mkdir(parents=True, exist_ok=True)
                (result_dir / "talk.mp4").write_bytes(b"0" * 2048)

                class Completed:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Completed()

            face = Path(tmp) / "scene-1.png"
            audio = Path(tmp) / "narration.mp3"
            face.write_bytes(b"png")
            audio.write_bytes(b"mp3")
            output = Path(tmp) / "lipsync.mp4"
            report = readiness(root, {"available": True, "name": "Tesla T4", "memoryMiB": 15360})
            self.assertTrue(report["ready"])
            self.assertFalse(report["executed"])
            generate_lipsync(
                face, audio, output, root=root, runner=runner,
                gpu={"available": True, "name": "Tesla T4", "memoryMiB": 15360},
            )
            self.assertEqual(calls[0][1], str(root))
            self.assertIn("scripts.inference", calls[0][0])
            self.assertIn("v15", calls[0][0])
            self.assertGreaterEqual(output.stat().st_size, 1024)

    def test_requested_lipsync_fails_closed_without_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = {"lipSync": {"engine": "musetalk"}, "scenes": []}
            with self.assertRaises(MuseTalkNotExecuted) as caught:
                attach_musetalk_video(manifest, Path(tmp))
        self.assertIn("was not executed", str(caught.exception))
        self.assertNotIn("lipsyncFile", manifest)

    def test_queue_hook_skips_when_not_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            manifest = {"scenes": []}
            attach_musetalk_video(manifest, assets)
            self.assertNotIn("lipsyncFile", manifest)


if __name__ == "__main__":
    unittest.main()
