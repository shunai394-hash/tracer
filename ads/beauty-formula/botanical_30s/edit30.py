"""Assemble the 30s 9:16 botanical protein ad with burned-in captions.

Usage: python3 edit30.py <clips_dir> <fonts_dir> <pkg_cut.png> <out_video.mp4> [preview t1 t2 ...]
Clips are c1..c9.mp4 from Higgsfield (Kling 3.0). Output is silent; audio is muxed later.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CLIPS, FONTS, PKG, OUT = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
PREVIEW = [float(x) for x in sys.argv[6:]] if len(sys.argv) > 5 and sys.argv[5] == "preview" else None
W, H, FPS, DUR = 1080, 1920, 30, 30.0

GOTHIC = str(FONTS / "expo-google-fonts-zen-kaku-gothic-new-0.4.2/900Black/ZenKakuGothicNew_900Black.ttf")
GOTHIC_B = str(FONTS / "expo-google-fonts-zen-kaku-gothic-new-0.4.2/700Bold/ZenKakuGothicNew_700Bold.ttf")
LATIN = str(FONTS / "expo-google-fonts-cormorant-garamond-0.4.1/700Bold/CormorantGaramond_700Bold.ttf")
MINCHO = str(FONTS / "expo-google-fonts-shippori-mincho-0.4.1/600SemiBold/ShipporiMincho_600SemiBold.ttf")

WHITE, PINK, COCOA = (255, 255, 255), (255, 92, 138), (59, 36, 26)
IVORY, BLUSH = (251, 246, 241), (246, 226, 224)

# (start, end, clip, clip_offset, zoom_from, zoom_to)
CUTS = [
    (0.0, 2.6, "c1", 0.0, 1.00, 1.06),
    (2.6, 5.4, "c2", 0.2, 1.00, 1.05),
    (5.4, 8.4, "c3", 0.4, 1.02, 1.07),
    (8.4, 11.5, "c4", 0.6, 1.00, 1.05),
    (11.5, 15.1, "c5", 0.3, 1.00, 1.06),
    (15.1, 19.0, "c6", 0.1, 1.00, 1.06),
    (19.0, 21.4, "c7", 0.6, 1.00, 1.04),
    (21.4, 24.6, "c8", 1.0, 1.00, 1.03),
    (24.6, 27.4, "c9", 0.6, 1.00, 1.04),
    (27.4, 30.0, "end", 0.0, 1.00, 1.03),
]

# captions follow the narration timing in mix30.sh
CAPS = [
    (0.15, 2.55, [[("ビール", WHITE), ("20L", PINK), ("分", WHITE)]], 150, 0.50),
    (2.65, 5.35, [[("希少ホップ成分「8PN」が", WHITE)], [("1杯", PINK), ("に", WHITE)]], 78, 0.70),
    (5.5, 8.35, [[("朝はコーヒーだけ…", WHITE)]], 84, 0.74),
    (9.05, 11.45, [[("植物生まれの", WHITE)], [("プロテイン", PINK)]], 96, 0.72),
    (11.55, 13.35, [[("ソイ × ピー × ヘンプ", WHITE)]], 86, 0.70),
    (13.35, 15.05, [[("たんぱく質 約", WHITE), ("16g", PINK)]], 96, 0.70),
    (15.15, 16.4, [[("スーパーフード", WHITE), ("6種", PINK)]], 90, 0.68),
    (16.4, 17.6, [[("乳酸菌", WHITE), ("22種", PINK)]], 100, 0.68),
    (17.6, 18.95, [[("コラーゲン", PINK), ("配合", WHITE)]], 100, 0.68),
    (19.05, 21.35, [[("まるで", WHITE), ("ショコラ", PINK)]], 120, 0.74),
    (21.5, 24.55, [[("香料・着色料・保存料", WHITE)], [("不使用", PINK)]], 80, 0.80),
    (24.7, 27.35, [[("内側から、毎日の私に。", WHITE)]], 80, 0.76),
]
NOTES = [
    (0.0, 5.4, "※8PNをビールから摂る場合のメーカー試算。飲酒を勧めるものではありません。"),
    (13.35, 15.1, "※1食（20g）あたり"),
]

_fonts = {}


def font(path, size):
    if (path, size) not in _fonts:
        _fonts[(path, size)] = ImageFont.truetype(path, size)
    return _fonts[(path, size)]


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def caption_layer(lines, size, alpha, scale):
    """Render caption lines (with pink keywords) as an RGBA image."""
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
            f = font(GOTHIC_B, 26)
            w = d.textlength(txt, font=f)
            d.text(((W - w) / 2, H - 120), txt, font=f, fill=(255, 255, 255, 230),
                   stroke_width=2, stroke_fill=(40, 20, 15, 200))


def gradient_bg():
    y = np.linspace(0, 1, H)[:, None, None]
    a = np.array(IVORY, np.float32) * (1 - y) + np.array(BLUSH, np.float32) * y
    return Image.fromarray(np.repeat(a, W, axis=1).astype(np.uint8))


END_BG = gradient_bg()
PKG_IMG = Image.open(PKG).convert("RGBA")


def end_card(t, dur):
    k = 1 + 0.03 * ease(t / dur)
    ph = int(H * 0.47 * k)
    pw = int(PKG_IMG.width * ph / PKG_IMG.height)
    p = PKG_IMG.resize((pw, ph), Image.LANCZOS)
    frame = END_BG.convert("RGBA")
    sh = Image.new("RGBA", (pw + 160, ph + 160), (0, 0, 0, 0))
    sh.paste((90, 40, 40, 80), (80, 80), p.getchannel("A"))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    x, y = (W - pw) // 2, int(H * 0.30 - ph / 2)
    frame.alpha_composite(sh, (x - 66, y - 50))
    frame.alpha_composite(p, (x, y))
    a = ease(t / 0.35)
    d = ImageDraw.Draw(frame)
    for txt, fp, size, col, yy in [
        ("BEAUTY FORMULA", LATIN, 118, COCOA, 0.635),
        ("ボタニカルプロテイン", MINCHO, 58, (214, 72, 102), 0.695),
        ("チョコレート風味｜300g", MINCHO, 50, COCOA, 0.735),
    ]:
        f = font(fp if "｜" not in txt else str(FONTS / "expo-google-fonts-noto-serif-jp-0.4.4/600SemiBold/NotoSerifJP_600SemiBold.ttf"), size)
        w = d.textlength(txt, font=f)
        d.text(((W - w) / 2, H * yy), txt, font=f, fill=col + (int(255 * a),))
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
            # quick white flash on the hook-to-story transitions
            if s in (2.6, 5.4) and lt < 0.1:
                base = Image.blend(base, Image.new("RGBA", (W, H), (255, 255, 255, 255)), 0.6 * (1 - lt / 0.1))
            draw_captions(base, t)
            return base.convert("RGB")


def main():
    if PREVIEW:
        for t in PREVIEW:
            for s, e, name, off, *_ in CUTS:
                if s <= t < e and name != "end":
                    r = {name: ClipReader(name, off + (t - s))}
                    break
            else:
                r = {}
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
