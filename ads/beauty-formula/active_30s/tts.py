"""Japanese narration for the Protein ACTIVE ad (Kokoro jf_alpha). Usage: python tts.py <speed>"""
import sys, soundfile as sf
from kokoro_onnx import Kokoro
from misaki import ja
g2p = ja.JAG2P()
k = Kokoro("/home/user/models/kokoro-v1.0.onnx", "/home/user/models/voices-v1.0.bin")
# Readings are written in kana so the TTS cannot misread them.
lines = [
 "えいようほきゅう、ふやすほど、つづかない。",
 "まいあさ、あれもこれもで、ひとくろう。",
 "もっとシンプルに、じぶんをととのえたい。",
 "たんぱくしつも、ビタミンも、ミネラルも。",
 "まいにちのえいようほきゅうを、このいっぱいに。",
 "ごほうびみたいな、のうこうチョコレートふうみ。",
 "がんばりすぎず、じぶんみがきをつづけよう。",
 "ビューティーフォーミュラ、プロテイン、アクティブ。",
 "アマゾンで、チェック。",
]
speed = float(sys.argv[1])
for i, s in enumerate(lines, 1):
    ph = g2p(s); ph = ph[0] if isinstance(ph, tuple) else ph
    a, sr = k.create(ph, voice="jf_alpha", speed=speed, lang="ja", is_phonemes=True)
    sf.write(f"na/l{i:02d}.wav", a, sr)
    print(i, round(len(a)/sr, 2), ph)
