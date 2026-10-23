"""Cut the pouch out of pkg2.png (white studio background) -> pkg_cut.png.

The pouch is pink and its label is enclosed by it, so non-pink pixels connected
to the image border are background; this also drops the soft floor shadow.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
im = Image.open(HERE / "pkg2.png").convert("RGB")
a = np.asarray(im).astype(int)
pinkish = (a[..., 0] - a[..., 2] > 9) | (a.max(-1) < 200)
v = np.where(pinkish, 0, 255).astype("uint8")
flood = Image.fromarray(np.stack([v, v, v], -1))
for p in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]:
    ImageDraw.floodfill(flood, p, (255, 0, 255))
f = np.asarray(flood)
bg = (f[..., 0] == 255) & (f[..., 1] == 0)
mask = Image.fromarray(np.where(bg, 0, 255).astype("uint8"))
mask = mask.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.0))
out = im.copy()
out.putalpha(mask)
out.crop(mask.getbbox()).save(HERE / "pkg_cut.png")
