"""SNS thumbnails (9:16 and 1:1) for the Protein ACTIVE ad.

Usage: python3 thumb.py <scene.png> <pkg_cut.png> <fonts_dir> <out_prefix>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SCENE, PKG, FONTS, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4]
GOTHIC = str(FONTS / "expo-google-fonts-zen-kaku-gothic-new-0.4.2/900Black/ZenKakuGothicNew_900Black.ttf")
LATIN = str(FONTS / "expo-google-fonts-cormorant-garamond-0.4.1/700Bold/CormorantGaramond_700Bold.ttf")
WHITE, PINK, COCOA = (255, 255, 255), (255, 92, 138), (59, 36, 26)


def text_center(d, y, segs, size, W):
    f = ImageFont.truetype(GOTHIC, size)
    stroke = max(3, size // 11)
    widths = [d.textlength(t, font=f) for t, _ in segs]
    x = (W - sum(widths)) / 2
    for (t, col), w in zip(segs, widths):
        d.text((x, y), t, font=f, fill=col, stroke_width=stroke, stroke_fill=(45, 22, 18))
        x += w


def make(W, H, name):
    bg = Image.open(SCENE).convert("RGB")
    s = max(W / bg.width, H / bg.height)
    bg = bg.resize((int(bg.width * s), int(bg.height * s)), Image.LANCZOS)
    bg = bg.crop(((bg.width - W) // 2, 0, (bg.width - W) // 2 + W, H)).convert("RGBA")
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shade).rectangle((0, 0, W, int(H * 0.36)), fill=(30, 15, 10, 110))
    bg.alpha_composite(shade.filter(ImageFilter.GaussianBlur(40)))
    d = ImageDraw.Draw(bg)
    big = int(W * 0.088)
    text_center(d, int(H * 0.05), [("栄養補給、", WHITE)], big, W)
    text_center(d, int(H * 0.05) + int(big * 1.25), [("増やすほど", WHITE), ("続かない？", PINK)], big, W)
    pkg = Image.open(PKG).convert("RGBA")
    ph = int(H * (0.50 if H > W else 0.52))
    pw = int(pkg.width * ph / pkg.height)
    pkg = pkg.resize((pw, ph), Image.LANCZOS)
    sh = Image.new("RGBA", (pw + 120, ph + 120), (0, 0, 0, 0))
    sh.paste((60, 20, 20, 120), (60, 60), pkg.getchannel("A"))
    x, y = W - pw - int(W * 0.04), H - ph - int(H * 0.04)
    bg.alpha_composite(sh.filter(ImageFilter.GaussianBlur(24)), (x - 50, y - 30))
    bg.alpha_composite(pkg, (x, y))
    tag = ImageFont.truetype(GOTHIC, int(W * 0.06))
    label = "この一杯に。"
    tw = d.textlength(label, font=tag)
    bx, by = int(W * 0.05), y + int(ph * 0.55)
    d.rounded_rectangle((bx, by, bx + tw + 60, by + int(W * 0.06) + 44), radius=30, fill=COCOA)
    d.text((bx + 30, by + 14), label, font=tag, fill=WHITE)
    bg.convert("RGB").save(f"{OUT}_{name}.jpg", quality=92)


make(1080, 1920, "9x16")
make(1080, 1080, "1x1")
