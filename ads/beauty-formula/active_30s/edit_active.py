"""Assemble the Beauty Formula Protein ACTIVE ads (9:16) with burned-in captions.

Usage: python3 edit_active.py <30|15> <clips_dir> <fonts_dir> <pkg_cut.png> <out.mp4> [preview t1 t2 ...]
Clips: hook, sigh, window, product, shaker, sip, walk (.mp4, Kling 3.0 / Higgsfield).
Output is silent; audio is muxed by mix_active.sh.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

VERSION, CLIPS, FONTS, PKG, OUT = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5]
PREVIEW = [float(x) for x in sys.argv[7:]] if len(sys.argv) > 6 and sys.argv[6] == "preview" else None
W, H, FPS = 1080, 1920, 30

GOTHIC = str(FONTS / "expo-google-fonts-zen-kaku-gothic-new-0.4.2/900Black/ZenKakuGothicNew_900Black.ttf")
GOTHIC_B = str(FONTS / "expo-google-fonts-zen-kaku-gothic-new-0.4.2/700Bold/ZenKakuGothicNew_700Bold.ttf")
LATIN = str(FONTS / "expo-google-fonts-cormorant-garamond-0.4.1/700Bold/CormorantGaramond_700Bold.ttf")
MINCHO = str(FONTS / "expo-google-fonts-shippori-mincho-0.4.1/600SemiBold/ShipporiMincho_600SemiBold.ttf")
SERIF = str(FONTS / "expo-google-fonts-noto-serif-jp-0.4.4/600SemiBold/NotoSerifJP_600SemiBold.ttf")

WHITE, PINK, COCOA = (255, 255, 255), (255, 92, 138), (59, 36, 26)
IVORY, BLUSH, ROSE = (251, 246, 241), (246, 226, 224), (214, 72, 102)

# Captions use one sentence per cut and follow the narration start times in mix_active.sh.
C_HOOK = [[("栄養補給、", WHITE)], [("増やすほど", WHITE), ("続かない。", PINK)]]
C_SIGH = [[("毎日の栄養補給、", WHITE)], [("あれこれ", WHITE), ("増えていませんか？", PINK)]]
C_WIN = [[("もっとシンプルに、", WHITE)], [("自分を整えたい。", WHITE)]]
C_PROD = [[("たんぱく質も、", WHITE), ("ビタミンも、", WHITE)], [("ミネラルも。", PINK)]]
C_SHAKE = [[("毎日の栄養補給を、", WHITE)], [("この一杯", PINK), ("に。", WHITE)]]
C_SIP = [[("ごほうび感のある", WHITE)], [("濃厚チョコレート風味", PINK)]]
C_WALK = [[("頑張りすぎず、", WHITE)], [("自分磨きを続けよう。", WHITE)]]
NOTE_PROD = "※配合成分・栄養成分は商品ページの表示をご確認ください"

if VERSION == "30":
    DUR = 30.0
    # (start, end, clip, clip_offset, zoom_from, zoom_to)
    CUTS = [
        (0.0, 3.0, "hook", 0.0, 1.00, 1.08),
        (3.0, 6.2, "sigh", 0.3, 1.00, 1.05),
        (6.2, 9.2, "window", 0.5, 1.02, 1.07),
        (9.2, 12.4, "product", 0.8, 1.00, 1.04),
        (12.4, 15.6, "shaker", 0.0, 1.00, 1.05),
        (15.6, 19.0, "sip", 0.3, 1.00, 1.05),
        (19.0, 22.8, "walk", 0.1, 1.00, 1.04),
        (22.8, 30.0, "end", 0.0, 1.00, 1.03),
    ]
    CAPS = [
        (0.2, 2.95, C_HOOK, 94, 0.40),
        (3.1, 6.15, C_SIGH, 80, 0.74),
        (6.4, 9.15, C_WIN, 88, 0.74),
        (9.4, 12.35, C_PROD, 74, 0.76),
        (12.6, 15.55, C_SHAKE, 88, 0.74),
        (15.8, 18.95, C_SIP, 84, 0.76),
        (19.2, 22.75, C_WALK, 86, 0.76),
    ]
    NOTES = [(9.2, 12.4, NOTE_PROD)]
    END_START, CTA_AT = 22.8, 25.6
else:
    DUR = 15.0
    CUTS = [
        (0.0, 2.8, "hook", 0.0, 1.00, 1.08),
        (2.8, 5.8, "product", 0.8, 1.00, 1.04),
        (5.8, 8.7, "shaker", 0.0, 1.00, 1.05),
        (8.7, 11.4, "sip", 0.5, 1.00, 1.05),
        (11.4, 15.0, "end", 0.0, 1.00, 1.03),
    ]
    CAPS = [
        (0.15, 2.75, C_HOOK, 94, 0.40),
        (2.9, 5.75, C_PROD, 74, 0.76),
        (5.9, 8.65, C_SHAKE, 88, 0.74),
        (8.8, 11.35, C_SIP, 84, 0.76),
    ]
    NOTES = [(2.8, 5.8, NOTE_PROD)]
    END_START, CTA_AT = 11.4, 13.2

_fonts = {}


def font(path, size):
    if (path, size) not in _fonts:
        _fonts[(path, size)] = ImageFont.truetype(path, size)
    return _fonts[(path, size)]


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def caption_layer(lines, size, alpha, scale):
    f = font(GOTHIC, max(8, int(size * scale)))
    stroke = max(2, int(size * scale * 0.09))
    rows = []
    for segs in lines:
        widths = [f.getbbox(t, stroke_width=stroke)[2] - f.getbbox(t, stroke_width=stroke)[0] for t, _ in segs]
        rows.append((segs, widths, sum(widths)))
    asc, desc = f.getmetrics()
    lh = asc + desc + stroke * 2
    img = Image.new("RGBA", (W, lh * len(rows) + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = 20
    for segs, widths, total in rows:
        x = (W - total) / 2
        for (t, col), w in zip(segs, widths):
            bx = f.getbbox(t, stroke_width=stroke)[0]
            d.text((x - bx, y), t, font=f, fill=col + (255,), stroke_width=stroke, stroke_fill=(45, 22, 18, 255))
            x += w
        y += lh
    shadow = img.getchannel("A").filter(ImageFilter.GaussianBlur(10)).point(lambda v: int(v * 0.5))
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste((0, 0, 0, 255), (0, 8), shadow)
    out.alpha_composite(img)
    if alpha < 1:
        out.putalpha(out.getchannel("A").point(lambda v: int(v * alpha)))
    return out


def draw_captions(frame, t):
    for t0, t1, lines, size, yc in CAPS:
        if t0 <= t < t1:
            k = ease((t - t0) / 0.18)
            out_k = min(1.0, (t1 - t) / 0.12)
            layer = caption_layer(lines, size, min(k, out_k), 0.82 + 0.18 * k)
            frame.alpha_composite(layer, (0, int(H * yc - layer.height / 2)))
    d = ImageDraw.Draw(frame)
    for t0, t1, txt in NOTES:
        if t0 <= t < t1:
            f = font(GOTHIC_B, 28)
            w = d.textlength(txt, font=f)
            d.text(((W - w) / 2, H - 130), txt, font=f, fill=(255, 255, 255, 235),
                   stroke_width=2, stroke_fill=(40, 20, 15, 200))


def gradient_bg():
    y = np.linspace(0, 1, H)[:, None, None]
    a = np.array(IVORY, np.float32) * (1 - y) + np.array(BLUSH, np.float32) * y
    return Image.fromarray(np.repeat(a, W, axis=1).astype(np.uint8))


END_BG = gradient_bg()
PKG_IMG = Image.open(PKG).convert("RGBA")


def cta_button(frame, t_in):
    """Amazon call-to-action pill that pops in and gently pulses."""
    if t_in < 0:
        return
    a = ease(t_in / 0.3)
    pulse = 1 + 0.03 * np.sin(max(0.0, t_in - 0.3) * 2 * np.pi / 1.2)
    bw, bh = int(640 * pulse), int(132 * pulse)
    x, y = (W - bw) // 2, int(H * 0.835 - bh / 2)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((x, y + 10, x + bw, y + bh + 10), radius=bh // 2, fill=(90, 30, 40, int(70 * a)))
    d.rounded_rectangle((x, y, x + bw, y + bh), radius=bh // 2, fill=COCOA + (int(255 * a),))
    f = font(GOTHIC, int(56 * pulse))
    txt = "Amazonでチェック  ›"
    w = d.textlength(txt, font=f)
    asc, desc = f.getmetrics()
    d.text(((W - w) / 2, y + (bh - asc - desc) / 2 - 4), txt, font=f, fill=WHITE + (int(255 * a),))
    frame.alpha_composite(layer)


def end_card(t, dur):
    """Package hero, brand, benefit line, flavor/size and Amazon CTA."""
    k = 1 + 0.03 * ease(t / dur)
    ph = int(H * 0.45 * k)
    pw = int(PKG_IMG.width * ph / PKG_IMG.height)
    p = PKG_IMG.resize((pw, ph), Image.LANCZOS)
    frame = END_BG.convert("RGBA")
    sh = Image.new("RGBA", (pw + 160, ph + 160), (0, 0, 0, 0))
    sh.paste((90, 40, 40, 80), (80, 80), p.getchannel("A"))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    x, y = (W - pw) // 2, int(H * 0.27 - ph / 2)
    frame.alpha_composite(sh, (x - 66, y - 50))
    frame.alpha_composite(p, (x, y))
    a = ease(t / 0.35)
    d = ImageDraw.Draw(frame)
    for txt, fp, size, col, yy in [
        ("BEAUTY FORMULA", LATIN, 116, COCOA, 0.535),
        ("Protein ACTIVE", LATIN, 76, ROSE, 0.595),
        ("毎日の栄養補給を、もっとシンプルに。", MINCHO, 50, COCOA, 0.665),
        ("濃厚チョコレート風味｜300g", SERIF, 44, COCOA, 0.715),
    ]:
        f = font(fp, size)
        w = d.textlength(txt, font=f)
        d.text(((W - w) / 2, H * yy), txt, font=f, fill=col + (int(255 * a),))
    cta_button(frame, END_START + t - CTA_AT)
    return frame


class ClipReader:
    def __init__(self, name, offset):
        cmd = ["ffmpeg", "-v", "error", "-ss", str(offset), "-i", str(CLIPS / f"{name}.mp4"),
               "-vf", f"fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        self.last = None

    def read(self):
        buf = self.p.stdout.read(W * H * 3)
        if len(buf) == W * H * 3:
            self.last = Image.frombytes("RGB", (W, H), buf)
        return self.last  # hold the last frame if the clip runs short


def zoomed(img, z):
    if z <= 1.0001:
        return img
    cw, ch = W / z, H / z
    return img.resize((W, H), Image.LANCZOS, box=((W - cw) / 2, (H - ch) / 2, (W + cw) / 2, (H + ch) / 2))


def render_frame(t, readers):
    for s, e, name, off, z0, z1 in CUTS:
        if s <= t < e or (e == DUR and t >= s):
            lt, dur = t - s, e - s
            z = z0 + (z1 - z0) * (lt / dur)
            if name == "end":
                base = end_card(lt, dur)
            else:
                if name not in readers:
                    readers.clear()
                    readers[name] = ClipReader(name, off)
                base = zoomed(readers[name].read(), z).convert("RGBA")
            # quick white flash out of the hook and into the product reveal
            if s > 0 and name in ("sigh", "product") and lt < 0.1:
                base = Image.blend(base, Image.new("RGBA", (W, H), (255, 255, 255, 255)), 0.6 * (1 - lt / 0.1))
            draw_captions(base, t)
            return base.convert("RGB")


def main():
    if PREVIEW:
        for t in PREVIEW:
            r = {}
            for s, e, name, off, *_ in CUTS:
                if s <= t < e and name != "end":
                    r = {name: ClipReader(name, off + (t - s))}
                    break
            render_frame(t, r).save(f"{OUT}_{t}.jpg", quality=80)
        return
    enc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                            "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                            "-pix_fmt", "yuv420p", OUT], stdin=subprocess.PIPE)
    readers = {}
    for i in range(int(DUR * FPS)):
        enc.stdin.write(render_frame(i / FPS, readers).tobytes())
    enc.stdin.close()
    sys.exit(enc.wait())


if __name__ == "__main__":
    main()
