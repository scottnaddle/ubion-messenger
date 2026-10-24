#!/usr/bin/env python3
"""Rasterize the Dawer app icon.

Original mark: the Hangul syllable 다 (the same letter as the in-app logo)
in cream on a warm rounded square. Not the UBION monogram and not a DaouOffice asset.

Colors:
  #FF8F6B  coral (gradient start, top-left)
  #E24B4B  warm red (gradient end, bottom-right)
  #FFF7F2  cream syllable

Requires Pillow and a Hangul face. Debian/Ubuntu: fonts-wqy-microhei.
Override the face with DAWER_ICON_FONT. Writes desktop/resources/dawer/.
"""
from __future__ import annotations

import io
import os
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "dawer"
MASTER = 1024
CORAL = (0xFF, 0x8F, 0x6B)
RED = (0xE2, 0x4B, 0x4B)
CREAM = (0xFF, 0xF7, 0xF2)
FONT_CANDIDATES = [
    os.environ.get("DAWER_ICON_FONT", ""),
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttf",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if path and Path(path).is_file():
            return path
    sys.exit("Hangul font not found. Install fonts-wqy-microhei or set DAWER_ICON_FONT.")


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def render_master(font_path: str, glyph_only: bool) -> Image.Image:
    size = MASTER
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.22), fill=255)
    if not glyph_only:
        px = img.load()
        mpx = mask.load()
        for y in range(size):
            fade = max(0.0, 1 - (y / size) / 0.5)
            hi = int(28 * fade)
            for x in range(size):
                if not mpx[x, y]:
                    continue
                t = (x + y) / (2 * (size - 1))
                r = lerp(CORAL[0], RED[0], t)
                g = lerp(CORAL[1], RED[1], t)
                b = lerp(CORAL[2], RED[2], t)
                r = min(255, r + (CREAM[0] - r) * hi // 255)
                g = min(255, g + (CREAM[1] - g) * hi // 255)
                b = min(255, b + (CREAM[2] - b) * hi // 255)
                px[x, y] = (r, g, b, 255)
    font = ImageFont.truetype(font_path, 680)
    draw = ImageDraw.Draw(img)
    text = "다"
    probe = Image.new("L", (size + 200, size + 200), 0)
    ImageDraw.Draw(probe).text((100, 100), text, font=font, fill=255)
    bb = probe.point(lambda p: 255 if p else 0).getbbox()
    if not bb:
        sys.exit("font did not draw 다")
    ink_w, ink_h = bb[2] - bb[0], bb[3] - bb[1]
    x = (size - ink_w) / 2 - (bb[0] - 100)
    y = (size - ink_h) / 2 - (bb[1] - 100)
    fill = (0, 0, 0, 255) if glyph_only else (*CREAM, 255)
    draw.text((x, y), text, font=font, fill=fill)
    return img


def down(master: Image.Image, size: int) -> Image.Image:
    if size == master.width:
        return master.copy()
    return master.resize((size, size), Image.Resampling.LANCZOS)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: Path, images: list[tuple[int, bytes]]) -> None:
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for size, png in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        blobs += png
    path.write_bytes(header + entries + blobs)


def write_icns(path: Path, images: dict[int, bytes]) -> None:
    # PNG-encoded icns. Retina types repeat the same pixels at the @2x size.
    types = {
        16: [b"icp4"],
        32: [b"icp5", b"ic11"],
        64: [b"icp6", b"ic12"],
        128: [b"ic07"],
        256: [b"ic08", b"ic13"],
        512: [b"ic09", b"ic14"],
        1024: [b"ic10"],
    }
    chunks = b""
    for size, os_types in types.items():
        png = images[size]
        for os_type in os_types:
            chunks += os_type + struct.pack(">I", 8 + len(png)) + png
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks)


def assert_icon(img: Image.Image) -> None:
    if img.getpixel((0, 0))[3] != 0:
        sys.exit("icon corners should be transparent")
    cream = coral = False
    step = max(1, img.width // 64)
    for y in range(0, img.height, step):
        for x in range(0, img.width, step):
            r, g, b, a = img.getpixel((x, y))
            if a < 200:
                continue
            if r > 245 and g > 230 and b > 220:
                cream = True
            if r > 210 and 40 < g < 180 and b < 150:
                coral = True
    if not (cream and coral):
        sys.exit("icon is missing the cream 다 or the warm background")


def main() -> None:
    font = find_font()
    OUT.mkdir(parents=True, exist_ok=True)
    master = render_master(font, glyph_only=False)
    assert_icon(master)
    glyph = render_master(font, glyph_only=True)
    pngs = {size: png_bytes(down(master, size)) for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024)}
    named = {
        16: "icon-16.png",
        32: "icon-32.png",
        64: "icon-64.png",
        128: "icon-128.png",
        256: "icon-256.png",
        512: "icon.png",
        1024: "icon-1024.png",
    }
    for size, name in named.items():
        (OUT / name).write_bytes(pngs[size])
    (OUT / "icon-mac.png").write_bytes(pngs[1024])
    (OUT / "tray.png").write_bytes(pngs[16])
    (OUT / "tray@2x.png").write_bytes(pngs[32])
    (OUT / "trayTemplate.png").write_bytes(png_bytes(down(glyph, 16)))
    (OUT / "trayTemplate@2x.png").write_bytes(png_bytes(down(glyph, 32)))
    write_ico(OUT / "icon.ico", [(s, pngs[s]) for s in (16, 24, 32, 48, 64, 128, 256)])
    write_icns(OUT / "icon.icns", pngs)
    with Image.open(OUT / "icon.ico") as ico:
        if ico.size != (256, 256):
            sys.exit(f"ico opened at {ico.size}, expected 256")
    print(f"wrote {OUT} using {font}")


if __name__ == "__main__":
    main()
