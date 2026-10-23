import sys, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
from misaki import ja
g2p = ja.JAG2P()
k = Kokoro(sys.argv[1] + "/kokoro-v1.0.onnx", sys.argv[1] + "/voices-v1.0.bin")
print([v for v in k.get_voices() if v.startswith("j")])
voice, speed, outdir = sys.argv[2], float(sys.argv[3]), sys.argv[4]
lines = ["自分をいたわる、毎日の新習慣。", "ビューティーフォーミュラ、チョコレート風味。",
         "おいしく楽しむ、わたしのためのひととき。", "毎日に、心地よい、いっぱいを。"]
for i, s in enumerate(lines, 1):
    ph = g2p(s)
    ph = ph[0] if isinstance(ph, tuple) else ph
    print(i, ph)
    a, sr = k.create(ph, voice=voice, speed=speed, lang="ja", is_phonemes=True)
    sf.write(f"{outdir}/{voice}_{i}.wav", a, sr)
    print(i, len(a) / sr, "s")
