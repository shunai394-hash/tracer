"""Original 30s upbeat pop bed (118 BPM, A minor -> C) synthesized from scratch.

Usage: python3 bgm_upbeat.py out.wav
"""
import sys
import wave

import numpy as np

SR, DUR = 48000, 30.0
N = int(SR * DUR)
BPM = 118
BEAT = 60 / BPM
rng = np.random.default_rng(3)
mix = np.zeros((N, 2))


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(sig, start, pan=0.0, gain=1.0):
    i0 = int(start * SR)
    if i0 >= N:
        return
    sig = sig[: N - i0] * gain
    mix[i0:i0 + len(sig), 0] += sig * (1 - max(pan, 0))
    mix[i0:i0 + len(sig), 1] += sig * (1 + min(pan, 0))


def kick():
    t = np.arange(int(0.35 * SR)) / SR
    f = 50 + 90 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)


def clap():
    t = np.arange(int(0.25 * SR)) / SR
    n = rng.standard_normal(len(t))
    env = np.exp(-t / 0.06) * (1 + 0.6 * (np.sin(2 * np.pi * 90 * t) > 0))
    return np.convolve(n, np.ones(6) / 6, "same") * env * 0.5


def hat(open_=False):
    t = np.arange(int((0.2 if open_ else 0.05) * SR)) / SR
    n = np.diff(rng.standard_normal(len(t) + 1))
    return n * np.exp(-t / (0.06 if open_ else 0.012)) * 0.25


def pluck(m, length=0.35):
    t = np.arange(int(length * SR)) / SR
    f = hz(m)
    s = sum(np.sin(2 * np.pi * f * k * t) / k ** 1.3 for k in range(1, 6))
    return s * np.exp(-t / 0.12) * (1 - np.exp(-t / 0.003))


def bass(m, length):
    t = np.arange(int(length * SR)) / SR
    f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)
    return s * np.minimum(1, t / 0.01) * np.exp(-t / 0.4)


def pad(notes, length):
    t = np.arange(int(length * SR)) / SR
    env = np.minimum(1, t / 0.3) * np.minimum(1, (length - t) / 0.3)
    return sum(np.sin(2 * np.pi * hz(m + d) * t) for m in notes for d in (-0.08, 0.08)) * env * 0.04


def layer(*sigs):
    """Sum signals of different lengths."""
    out = np.zeros(max(len(x) for x in sigs))
    for x in sigs:
        out[:len(x)] += x
    return out


def riser(length):
    t = np.arange(int(length * SR)) / SR
    n = rng.standard_normal(len(t))
    k = np.ones(40) / 40
    return (n - np.convolve(n, k, "same")) * (t / length) ** 2 * 0.35


# chords per bar (4 beats): Am F C G, final bar C
prog = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [55, 60, 64]), (55, [55, 59, 62])]
bar = 4 * BEAT
n_bars = int(np.ceil(DUR / bar))
for b in range(n_bars):
    t0 = b * bar
    root, chord = prog[b % 4]
    final = t0 >= 27.0
    if final:
        root, chord = 48, [60, 64, 67]
    add(pad(chord + [chord[0] + 12], bar + 0.3), t0, gain=1.0)
    intro = t0 < 2.4  # sparse hook: hits only
    for q in range(4):
        tb = t0 + q * BEAT
        if tb >= DUR:
            break
        if not intro:
            add(kick(), tb, gain=0.9)
            add(hat(), tb + BEAT / 2, pan=0.3)
            add(hat(), tb + BEAT / 4, pan=-0.3, gain=0.5)
            add(hat(), tb + 3 * BEAT / 4, pan=-0.3, gain=0.5)
            if q in (1, 3):
                add(clap(), tb, gain=0.7)
            add(bass(root - 12, BEAT * 0.9), tb, gain=0.55)
            add(bass(root - 12, BEAT * 0.4), tb + BEAT / 2, gain=0.35)
        # pluck arpeggio in 8ths
        for e in range(2):
            m = (chord + [chord[1] + 12])[(q * 2 + e) % 4] + 12
            add(pluck(m), tb + e * BEAT / 2, pan=0.25 * (1 if e else -1), gain=0.22)
# hook impacts at 0 and 1.3s, riser into the drop at 2.6s
add(layer(kick() * 1.4, clap()), 0.0, gain=0.9)
add(kick() * 1.2, 1.3, gain=0.8)
add(riser(1.2), 1.4)
add(layer(clap(), kick()), 2.6, gain=1.0)

mix = np.tanh(mix * 1.2)
fade = np.minimum(1, (DUR - np.arange(N) / SR) / 1.0)[:, None]
mix = mix * fade
mix = mix / np.max(np.abs(mix)) * 0.8
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
