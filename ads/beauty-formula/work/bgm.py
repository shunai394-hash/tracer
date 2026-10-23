"""Synthesize an original 15s calm piano + pad bed (no third-party samples)."""
import sys
import wave

import numpy as np

SR, DUR = 48000, 15.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def piano(m, start, length=2.6, vel=0.5):
    out = np.zeros(N)
    i0 = int(start * SR)
    n = min(int(length * SR), N - i0)
    if n <= 0:
        return out
    tt = np.arange(n) / SR
    f = hz(m)
    tone = sum(np.sin(2 * np.pi * f * k * tt * (1 + 0.0004 * k)) * a
               for k, a in [(1, 1.0), (2, 0.42), (3, 0.18), (4, 0.08), (5, 0.04)])
    env = (1 - np.exp(-tt / 0.006)) * np.exp(-tt / 0.9) * 0.8 + np.exp(-tt / 3.0) * 0.2
    out[i0:i0 + n] = tone * env * vel
    return out


def pad(notes, start, end, vel=0.08):
    out = np.zeros(N)
    i0, i1 = int(start * SR), min(int(end * SR), N)
    tt = np.arange(i1 - i0) / SR
    L = (i1 - i0) / SR
    env = np.minimum(1, tt / 0.9) * np.minimum(1, (L - tt) / 0.9)
    for m in notes:
        for det in (-0.12, 0.0, 0.12):
            out[i0:i1] += np.sin(2 * np.pi * hz(m + det) * tt) * env * vel / 3
    return out


beat = 60 / 72
# Fmaj9 - Dm9 - Bbmaj7 - Csus4 - Fmaj (final on end card ~12.9s)
chords = [
    (0.0, [53, 57, 60, 64, 67], [65, 69, 72, 76]),
    (4 * beat, [50, 53, 57, 60, 64], [62, 65, 69, 72]),
    (8 * beat, [46, 50, 53, 57, 62], [62, 65, 69, 70]),
    (12 * beat, [48, 53, 55, 60], [60, 65, 67, 72]),
    (12.9, [41, 53, 57, 60, 64], [65, 69, 72, 76, 77]),
]
mix = np.zeros(N)
for idx, (st, padn, arp) in enumerate(chords):
    en = chords[idx + 1][0] if idx + 1 < len(chords) else DUR
    mix += pad(padn, st, en + 0.4)
    mix += piano(padn[0] - 12 if padn[0] > 45 else padn[0], st, 4.0, 0.35)
    if idx < 4:
        step = beat / 2
        k = 0
        tt = st + step
        while tt < en - 0.05:
            mix += piano(arp[k % len(arp)], tt, 2.0, 0.17 + 0.03 * ((k + 1) % 2))
            k += 1
            tt += step
    else:  # final rolled chord
        for j, m in enumerate(arp):
            mix += piano(m, st + 0.06 * j, 2.4, 0.2)

# simple stereo reverb: convolve with decaying noise
ir_len = int(1.8 * SR)
it = np.arange(ir_len) / SR
irs = [rng.standard_normal(ir_len) * np.exp(-it / 0.45) for _ in range(2)]
def conv(x, h):
    L = len(x) + len(h)
    n = 1 << (L - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(h, n), n)[:len(x)]
wet = [conv(mix, h) for h in irs]
wet = [w / np.max(np.abs(w)) for w in wet]
dry = mix / np.max(np.abs(mix))
st = np.stack([dry * 0.8 + wet[0] * 0.35, dry * 0.8 + wet[1] * 0.35], 1)
fade_in = np.minimum(1, t / 0.4)[:, None]
fade_out = np.minimum(1, (DUR - t) / 1.2)[:, None]
st = st * fade_in * fade_out
st = st / np.max(np.abs(st)) * 0.7
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((st * 32767).astype("<i2").tobytes())
