import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from renderer import validate_manifest


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

    def test_rejects_empty_scenes(self):
        with self.assertRaises(ValueError):
            validate_manifest({"format": "muse-motion-manifest", "version": 1, "scenes": []})


if __name__ == "__main__":
    unittest.main()
