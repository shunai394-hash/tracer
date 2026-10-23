"""BEAUTY FORMULA 15s ad renderer.

Usage: python3 -I render.py <W> <H> <with_text:0|1> <out.mp4>
Frames are drawn with PIL from the supplied product photos (no generative
alteration of the package) and piped to ffmpeg as raw RGB.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, WITH_TEXT, OUT = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4]
VERT = H > W
FPS, DUR = 30, 15.0
N = int(FPS * DUR)
HERE = Path(__file__).parent
FONTS = HERE.parent / "fonts"
MINCHO = str(FONTS / "expo-google-fonts-shippori-mincho-0.4.1/600SemiBold/ShipporiMincho_600SemiBold.ttf")
MINCHO_B = str(FONTS / "expo-google-fonts-shippori-mincho-0.4.1/700Bold/ShipporiMincho_700Bold.ttf")
NOTO = str(FONTS / "expo-google-fonts-noto-serif-jp-0.4.4/600SemiBold/NotoSerifJP_600SemiBold.ttf")
LATIN = str(FONTS / "expo-google-fonts-cormorant-garamond-0.4.1/700Bold/CormorantGaramond_700Bold.ttf")

IVORY = (251, 246, 241)
BLUSH = (246, 226, 224)
COCOA = (59, 36, 26)
ROSE = (214, 72, 102)

scene_img = Image.open(HERE / "pkg1.png").convert("RGB")  # lifestyle photo
pkg = Image.open(HERE / "pkg_cut.png").convert("RGBA")    # cut-out package (photo 2)


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def lerp(a, b, x):
    return a + (b - a) * x


def kenburns(src, box0, box1, t, size=None):
    """Crop src from box0 to box1 (x0,y0,x1,y1, float) and fill the frame."""
    e = ease(t)
    box = tuple(lerp(a, b, e) for a, b in zip(box0, box1))
    return src.resize(size or (W, H), Image.LANCZOS, box=box)


def fit_box(cx, cy, w, src, aspect=None):
    """Box of width w centred on (cx,cy) with the frame aspect, clamped to src."""
    aspect = aspect or H / W
    w = min(w, src.width, src.height / aspect)
    h = w * aspect
    x0 = min(max(cx - w / 2, 0), src.width - w)
    y0 = min(max(cy - h / 2, 0), src.height - h)
    return (x0, y0, x0 + w, y0 + h)


def sharpen(im):
    return im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))


def warm_grade(im, amount=0.06):
    a = np.asarray(im).astype(np.float32)
    a[..., 0] *= 1 + amount
    a[..., 2] *= 1 - amount * 0.6
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


# ---------- static backgrounds ----------
def gradient_bg():
    y = np.linspace(0, 1, H)[:, None, None]
    top, bot = np.array(IVORY, np.float32), np.array(BLUSH, np.float32)
    a = top * (1 - y) + bot * y
    a = np.repeat(a, W, axis=1)
    # soft pink glow
    yy, xx = np.mgrid[0:H, 0:W]
    cx, cy = (W * 0.5, H * 0.42) if VERT else (W * 0.33, H * 0.5)
    r = np.sqrt(((xx - cx) / (W * 0.55)) ** 2 + ((yy - cy) / (H * 0.45)) ** 2)
    glow = np.clip(1 - r, 0, 1)[..., None] ** 2
    a = a * (1 - glow * 0.35) + np.array((255, 214, 220), np.float32) * glow * 0.35
    return Image.fromarray(a.astype(np.uint8))


BG = gradient_bg()

# blurred backdrop for the letterboxed full-photo shot
_bw = max(W, H)
BLUR_BD = scene_img.resize((_bw, _bw), Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
BLUR_BD = BLUR_BD.crop(((_bw - W) // 2, (_bw - H) // 2, (_bw - W) // 2 + W, (_bw - H) // 2 + H))
BLUR_BD = Image.blend(BLUR_BD, Image.new("RGB", (W, H), IVORY), 0.35)


def package_layer(scale_h, cx, cy, sheen_t=None):
    """Return (rgba image, x, y) of the package at a given height with shadow."""
    ph = int(scale_h)
    pw = int(pkg.width * ph / pkg.height)
    p = pkg.resize((pw, ph), Image.LANCZOS)
    if sheen_t is not None and 0 < sheen_t < 1:
        # diagonal light sweep, masked to the package; subtle so the label stays legible
        yy, xx = np.mgrid[0:ph, 0:pw]
        pos = lerp(-0.4, 1.4, ease(sheen_t)) * (pw + ph)
        d = (xx + yy * 0.6) - pos
        band = np.exp(-(d / (pw * 0.12)) ** 2) * 0.22
        arr = np.asarray(p).astype(np.float32)
        arr[..., :3] = arr[..., :3] * (1 - band[..., None]) + 255 * band[..., None]
        p = Image.fromarray(arr.astype(np.uint8), "RGBA")
    return p, int(cx - pw / 2), int(cy - ph / 2)


def composite_package(base, scale_h, cx, cy, sheen_t=None):
    p, x, y = package_layer(scale_h, cx, cy, sheen_t)
    shadow = Image.new("RGBA", p.size, (90, 40, 40, 0))
    shadow.putalpha(p.getchannel("A").point(lambda v: int(v * 0.28)))
    pad = 80
    sh = Image.new("RGBA", (p.width + pad * 2, p.height + pad * 2), (0, 0, 0, 0))
    sh.paste(shadow, (pad, pad))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    out = base.convert("RGBA")
    out.alpha_composite(sh, (x - pad + 14, y - pad + 30))
    out.alpha_composite(p, (x, y))
    return out.convert("RGB")


# ---------- text ----------
_font_cache = {}


def font(path, size):
    k = (path, size)
    if k not in _font_cache:
        _font_cache[k] = ImageFont.truetype(path, size)
    return _font_cache[k]


def text_alpha(t, t0, t1, fade=0.35):
    if t < t0 or t > t1:
        return 0.0
    return min(ease((t - t0) / fade), ease((t1 - t) / fade))


def draw_caption(im, lines, cy, alpha, panel=True, rise=0.0):
    """Centered multi-line caption on a translucent ivory panel."""
    if alpha <= 0:
        return im
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    metrics = []
    for txt, path, size, color in lines:
        f = font(path, size)
        b = d.textbbox((0, 0), txt, font=f)
        metrics.append((txt, f, color, b[2] - b[0], b[3] - b[1], b))
    gap = int(min(W, H) * 0.022)
    total_h = sum(m[4] for m in metrics) + gap * (len(metrics) - 1)
    max_w = max(m[3] for m in metrics)
    cy = cy + (1 - alpha) * rise
    y = cy - total_h / 2
    if panel:
        px, py = int(min(W, H) * 0.06), int(min(W, H) * 0.04)
        d.rounded_rectangle(
            (W / 2 - max_w / 2 - px, y - py, W / 2 + max_w / 2 + px, y + total_h + py),
            radius=int(min(W, H) * 0.04), fill=(255, 250, 246, int(215 * alpha)))
    for txt, f, color, tw, th, b in metrics:
        d.text((W / 2 - tw / 2 - b[0], y - b[1]), txt, font=f, fill=color + (int(255 * alpha),))
        y += th + gap
    out = im.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


S = min(W, H) / 1080  # type scale
CAP = int(68 * S)

# ---------- shots ----------
choc_box0 = fit_box(132, 1010, 250, scene_img)
choc_box1 = fit_box(120, 1000, 215, scene_img)
glass_box0 = fit_box(1128, 860, 240, scene_img)
glass_box1 = fit_box(1128, 790, 230, scene_img)
HALF = (W // 2, H)  # landscape split-screen panes (8:9)
split_choc0 = fit_box(132, 1010, 265, scene_img, H / (W // 2))
split_choc1 = fit_box(125, 1000, 235, scene_img, H / (W // 2))
split_glass0 = fit_box(1127, 690, 254, scene_img, H / (W // 2))
split_glass1 = fit_box(1127, 730, 232, scene_img, H / (W // 2))
if VERT:  # start on the package, settle on the drink
    life_box0 = fit_box(640, 640, 705, scene_img)
    life_box1 = fit_box(980, 640, 640, scene_img)
else:
    life_box0 = fit_box(627, 560, 1254, scene_img)
    life_box1 = fit_box(700, 700, 1180, scene_img)


def shot_split(t, dur=3.5):
    left = kenburns(scene_img, split_choc0, split_choc1, t / dur, HALF)
    right = kenburns(scene_img, split_glass0, split_glass1, t / dur, HALF)
    out = Image.new("RGB", (W, H), IVORY)
    out.paste(left, (0, 0))
    out.paste(right, (W - HALF[0], 0))
    ImageDraw.Draw(out).rectangle((W // 2 - 3, 0, W // 2 + 3, H), fill=IVORY)
    return warm_grade(sharpen(out))


def shot_choc(t):
    return warm_grade(sharpen(kenburns(scene_img, choc_box0, choc_box1, t / 1.9)))


def shot_glass(t):
    return warm_grade(sharpen(kenburns(scene_img, glass_box0, glass_box1, t / 1.9)))


def shot_hero(t, dur=4.4):
    e = ease(t / dur)
    if VERT:
        h = lerp(H * 0.53, H * 0.57, e)
        cx, cy = W / 2, H * 0.40
    else:
        h = lerp(H * 0.80, H * 0.84, e)
        cx, cy = W * 0.33, H * 0.50
    return composite_package(BG, h, cx, cy, sheen_t=(t - 0.9) / 1.6)


def shot_life(t, dur=4.4):
    return warm_grade(kenburns(scene_img, life_box0, life_box1, t / dur), 0.03)


def shot_full(t, dur=1.8):
    """Full lifestyle photo as a rounded card on the brand gradient."""
    side = int(lerp(min(W, H) * 0.86, min(W, H) * 0.82, ease(t / dur)))
    if not VERT:
        side = int(H * lerp(0.86, 0.82, ease(t / dur)))
    ph = scene_img.resize((side, side), Image.LANCZOS).convert("RGBA")
    m = Image.new("L", (side, side), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, side - 1, side - 1), radius=int(side * 0.04), fill=255)
    ph.putalpha(m)
    cy = H * 0.42 if VERT else H / 2
    x, y = int(W / 2 - side / 2), int(cy - side / 2)
    pad = 80
    sh = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", (side, side), (90, 40, 40, 70)), (pad, pad), m)
    sh = sh.filter(ImageFilter.GaussianBlur(30))
    out = BG.convert("RGBA")
    out.alpha_composite(sh, (x - pad + 10, y - pad + 26))
    out.alpha_composite(ph, (x, y))
    return out.convert("RGB")


def shot_end(t, dur=2.1):
    k = lerp(1.0, 1.025, ease(t / dur))
    if VERT:
        return composite_package(BG, H * 0.46 * k, W / 2, H * 0.33)
    return composite_package(BG, H * 0.80 * k, W * 0.30, H * 0.5)


# (start, end, fn) — overlapping ranges cross-fade
SHOTS = [
    (0.0, 1.9, shot_choc),
    (1.6, 3.5, shot_glass),
    (3.2, 7.6, shot_hero),
    (7.3, 11.7, shot_life),
    (11.4, 13.2, shot_full),
    (12.9, 15.0, shot_end),
]
if not VERT:
    SHOTS = [(0.0, 3.5, shot_split)] + SHOTS[2:]
XF = 0.3


def frame(t):
    active = [(s, e, f) for s, e, f in SHOTS if s <= t < e or (e == DUR and t >= s)]
    s, e, f = active[0]
    img = f(t - s)
    if len(active) > 1:
        s2, e2, f2 = active[1]
        a = ease((t - s2) / XF)
        img = Image.blend(img, f2(t - s2), a)
    if t < 0.4:  # fade in from ivory
        img = Image.blend(Image.new("RGB", (W, H), IVORY), img, ease(t / 0.4))
    if WITH_TEXT:
        img = captions(img, t)
    return img


def captions(img, t):
    cap_y = H * 0.70 if VERT else H * 0.80
    a = text_alpha(t, 0.35, 3.25)
    img = draw_caption(img, [("自分をいたわる、", MINCHO, CAP, COCOA),
                             ("毎日の新習慣。", MINCHO, CAP, COCOA)], cap_y, a, rise=20 * S)
    a = text_alpha(t, 3.7, 7.35)
    if VERT:
        img = draw_caption(img, [("BEAUTY FORMULA", LATIN, int(96 * S), COCOA),
                                 ("チョコレート風味", MINCHO, CAP, ROSE)], H * 0.79, a, panel=False, rise=20 * S)
    else:
        img = draw_caption_at(img, W * 0.72, H * 0.5, [("BEAUTY FORMULA", LATIN, int(104 * S), COCOA),
                                                       ("チョコレート風味", MINCHO, CAP, ROSE)], a)
    a = text_alpha(t, 7.7, 11.45)
    img = draw_caption(img, [("おいしく楽しむ、", MINCHO, CAP, COCOA),
                             ("私のためのひととき。", MINCHO, CAP, COCOA)], cap_y, a, rise=20 * S)
    a = text_alpha(t, 11.55, 13.15)
    full_cap_y = H * 0.80 if VERT else H * 0.85
    img = draw_caption(img, [("毎日に、心地よい一杯を。", MINCHO, CAP, COCOA)], full_cap_y, a, rise=20 * S)
    a = text_alpha(t, 13.2, 15.6)
    end_lines = [("BEAUTY FORMULA", LATIN, int(110 * S), COCOA),
                 ("チョコレート風味｜300g", NOTO, int(62 * S), ROSE)]
    if VERT:
        img = draw_caption(img, end_lines, H * 0.645, a, panel=False)
        img = cta_button(img, W / 2, H * 0.735, a)
    else:
        img = draw_caption_at(img, W * 0.70, H * 0.40, end_lines, a)
        img = cta_button(img, W * 0.70, H * 0.60, a)
    return img


def draw_caption_at(im, cx, cy, lines, alpha):
    """Caption centred on an arbitrary x (landscape layouts)."""
    if alpha <= 0:
        return im
    shift = int(cx - W / 2)
    layer = Image.new("RGB", (W, H))
    tmp = draw_caption(Image.new("RGB", (W, H), (0, 0, 0)), lines, cy, 1.0, panel=False)
    mask = draw_caption(Image.new("RGB", (W, H), (0, 0, 0)),
                        [(t_, p, s, (255, 255, 255)) for t_, p, s, _ in lines], cy, 1.0, panel=False).convert("L")
    layer.paste(tmp, (shift, 0))
    m2 = Image.new("L", (W, H))
    m2.paste(mask, (shift, 0))
    return Image.composite(layer, im, m2.point(lambda v: int(v * alpha)))


def cta_button(im, cx, cy, alpha):
    if alpha <= 0:
        return im
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font(MINCHO_B, int(52 * S))
    txt = "商品詳細はこちら"
    b = d.textbbox((0, 0), txt, font=f)
    tw, th = b[2] - b[0], b[3] - b[1]
    pw, ph = tw / 2 + 60 * S, th / 2 + 30 * S
    d.rounded_rectangle((cx - pw, cy - ph, cx + pw, cy + ph), radius=int(ph),
                        fill=COCOA + (int(240 * alpha),))
    d.text((cx - tw / 2 - b[0], cy - th / 2 - b[1]), txt, font=f, fill=(255, 245, 240, int(255 * alpha)))
    out = im.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


def main():
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(N):
        p.stdin.write(frame(i / FPS).tobytes())
    p.stdin.close()
    sys.exit(p.wait())


if __name__ == "__main__":
    if len(sys.argv) > 5:  # preview stills: render.py W H text out t1 t2 ...
        for ts in sys.argv[5:]:
            frame(float(ts)).save(f"{OUT}_{ts}.png")
    else:
        main()
