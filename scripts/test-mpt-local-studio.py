from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "mpt-local-studio.py"
SPEC = importlib.util.spec_from_file_location("mpt_local_studio", SCRIPT)
assert SPEC and SPEC.loader
mpt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mpt)


class LocalStudioContractTests(unittest.TestCase):
    def test_cli_is_locked_to_local_assets_and_no_paid_video_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / ".venv" / "Scripts" / "mpt.exe"
            local_dir = root / "storage" / "local_videos" / "12345678-1234-1234-1234-123456789012"
            local_dir.mkdir(parents=True)
            files = [local_dir / "asset-01.mp4", local_dir / "asset-02.jpg"]
            command = mpt.create_cli_command(
                exe,
                "12345678-1234-1234-1234-123456789012",
                "Japanese short drama",
                "これはテスト台本です。",
                files,
                "local",
                [],
                "ja-JP-NanamiNeural",
                "9:16",
                5,
                True,
                None,
            )

        self.assertEqual(command[0], str(exe))
        self.assertIn("--video-source", command)
        self.assertEqual(command[command.index("--video-source") + 1], "local")
        self.assertIn("--video-materials", command)
        material_argument = command[command.index("--video-materials") + 1]
        self.assertTrue(all(str(path) in material_argument for path in files))
        self.assertTrue(all(path.is_relative_to(local_dir) for path in files))
        self.assertEqual(command[command.index("--bgm-type") + 1], "none")
        self.assertIn("--voice-name", command)
        self.assertIn("ja-JP-NanamiNeural", command)
        self.assertIn("--subtitle-enabled", command)
        self.assertNotIn("--confirm-seedance-charge", command)
        self.assertNotIn("--confirm-metaso-minimax-charge", command)
        self.assertNotIn("--confirm-wavespeed-charge", command)
        self.assertNotIn("--upload-post-enabled", command)
        worker_source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('DATA_DIR / "storage" / "local_videos" / task_id', worker_source)
        self.assertIn("cleanup_task_inputs(task)", worker_source)

    def test_pexels_mode_uses_user_terms_and_never_local_upload_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            exe = Path(temp) / ".venv" / "Scripts" / "mpt.exe"
            command = mpt.create_cli_command(
                exe,
                "12345678-1234-1234-1234-123456789012",
                "Japanese short drama",
                "これはテスト台本です。",
                [],
                "pexels",
                ["rainy Japanese train station", "lonely man at night"],
                "ja-JP-NanamiNeural",
                "9:16",
                5,
                True,
                None,
            )
        self.assertEqual(command[command.index("--video-source") + 1], "pexels")
        self.assertEqual(
            command[command.index("--video-terms") + 1],
            "rainy Japanese train station,lonely man at night",
        )
        self.assertIn("--match-materials-to-script", command)
        self.assertNotIn("--video-materials", command)
        self.assertNotIn("--confirm-seedance-charge", command)
        self.assertNotIn("--confirm-metaso-minimax-charge", command)

    def test_pexels_key_is_saved_only_in_the_private_mpt_config(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            (data / "config.toml").write_text(
                'pexels_api_keys = []\nupload_post_enabled = false\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            original = getattr(mpt, "DATA_DIR", None)
            mpt.DATA_DIR = data
            secret = "PEXELS-API-KEY-1234567890123456"
            try:
                mpt.save_pexels_api_key(secret)
                self.assertTrue(mpt.pexels_key_configured())
                import tomllib
                saved = tomllib.loads((data / "config.toml").read_text(encoding="utf-8"))
                self.assertEqual(saved["pexels_api_keys"], [secret])
            finally:
                if original is None:
                    delattr(mpt, "DATA_DIR")
                else:
                    mpt.DATA_DIR = original

    def test_pexels_key_is_never_accepted_as_an_arbitrary_multiline_value(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            (data / "config.toml").write_text(
                'pexels_api_keys = []\nupload_post_enabled = false\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            original = getattr(mpt, "DATA_DIR", None)
            mpt.DATA_DIR = data
            try:
                with self.assertRaises(ValueError):
                    mpt.save_pexels_api_key('bad-key\npexels_api_keys = ["injected"]')
            finally:
                if original is None:
                    delattr(mpt, "DATA_DIR")
                else:
                    mpt.DATA_DIR = original

    def test_private_mpt_config_is_created_from_the_isolated_venv(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / ".venv" / "Scripts" / "mpt.exe"
            template = (
                root / ".venv" / "Lib" / "site-packages" / "app"
                / "_assets" / "config.example.toml"
            )
            template.parent.mkdir(parents=True)
            template.write_text(
                'upload_post_enabled = false\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            data = root / "private-data"
            mpt.load_or_create_config(data, exe)
            self.assertEqual(
                (data / "config.toml").read_text(encoding="utf-8"),
                template.read_text(encoding="utf-8"),
            )

    def test_automatic_publishing_configuration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / ".venv" / "Scripts" / "mpt.exe"
            template = (
                root / ".venv" / "Lib" / "site-packages" / "app"
                / "_assets" / "config.example.toml"
            )
            template.parent.mkdir(parents=True)
            template.write_text(
                'upload_post_enabled = false\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            data = root / "private-data"
            data.mkdir()
            (data / "config.toml").write_text(
                'upload_post_enabled = true\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            with self.assertRaises(RuntimeError):
                mpt.load_or_create_config(data, exe)

    def test_existing_private_config_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / ".venv" / "Scripts" / "mpt.exe"
            template = (
                root / ".venv" / "Lib" / "site-packages" / "app"
                / "_assets" / "config.example.toml"
            )
            template.parent.mkdir(parents=True)
            template.write_text(
                'upload_post_enabled = false\nupload_post_auto_upload = false\n',
                encoding="utf-8",
            )
            data = root / "private-data"
            data.mkdir()
            custom = 'upload_post_enabled = false\nupload_post_auto_upload = false\ncustom_marker = "keep"\n'
            (data / "config.toml").write_text(custom, encoding="utf-8")
            mpt.load_or_create_config(data, exe)
            self.assertEqual((data / "config.toml").read_text(encoding="utf-8"), custom)

    def test_child_process_does_not_inherit_external_paid_provider_keys(self):
        keys = [
            "PEXELS_API_KEY",
            "WAVESPEED_API_KEY",
            "METASO_MINIMAX_API_KEY",
            "ELEVENLABS_API_KEY",
            "OPENAI_API_KEY",
            "FISH_API_KEY",
        ]
        old = {key: os.environ.get(key) for key in keys}
        try:
            for key in keys:
                os.environ[key] = "test-secret"
            env = mpt.safe_child_environment(Path("private-data"))
            for key in keys:
                self.assertNotIn(key, env)
            self.assertEqual(env["MPT_HOME"], str(Path("private-data")))
            self.assertEqual(env["PYTHONUTF8"], "1")
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main(verbosity=2)
