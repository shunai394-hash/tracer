#!/usr/bin/env bash
# Re-fetch the large/third-party pieces that are not committed:
#   fonts (SIL OFL, via npm), Kokoro TTS model (Apache-2.0, GitHub release),
#   Japanese ASR model for narration QA (sherpa-onnx ReazonSpeech, GitHub release).
# Usage: ./setup.sh <scratch_dir>   (models/venv go there; fonts go to ./fonts)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${1:?scratch dir}
mkdir -p "$HERE/fonts" "$SCRATCH/tts-models" "$SCRATCH/asr"
(cd "$HERE/fonts" && npm pack @expo-google-fonts/shippori-mincho@0.4.1 @expo-google-fonts/noto-serif-jp@0.4.4 @expo-google-fonts/cormorant-garamond@0.4.1 >/dev/null \
  && for f in *.tgz; do tar xzf "$f" && mv package "${f%.tgz}"; rm "$f"; done)
python3 -m venv "$SCRATCH/tts-venv"
"$SCRATCH/tts-venv/bin/pip" install -q kokoro-onnx soundfile "misaki[ja]" sherpa-onnx
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  curl -sSL -o "$SCRATCH/tts-models/$f" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
done
curl -sSL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01.tar.bz2 | tar xj -C "$SCRATCH/asr"
echo "setup done"
