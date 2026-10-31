#!/usr/bin/env python3
"""Render the checked-in SVG master. Development-only: Pillow + CairoSVG."""
import argparse
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps/web/public"
BACKGROUND = "#f8faf9"
OUTPUTS = {
    "icons/icon-192.png": 192,
    "icons/icon-512.png": 512,
    "icons/maskable-512.png": 512,
    "icons/apple-touch-icon.png": 180,
    "icons/favicon-32.png": 32,
    "icons/favicon-16.png": 16,
}


def render(size):
    # Supersampling keeps the monogram and its counterforms clear at favicon sizes.
    png = cairosvg.svg2png(url=str(PUBLIC / "favicon.svg"),
                          output_width=size * 4, output_height=size * 4)
    return Image.open(BytesIO(png)).convert("RGB").resize(
        (size, size), Image.Resampling.LANCZOS)


def contact_sheet(path):
    sheet = Image.new("RGB", (1080, 840), "#e7eceb")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=20)
    small = ImageFont.load_default(size=16)
    draw.text((40, 28), "ANYONE IM / MONOGRAM SEAL", fill="#202a2b", font=font)
    sheet.paste(render(512), (40, 88))
    draw.text((40, 620), "512 px / full-bleed master", fill="#202a2b", font=small)
    for x, shape in [(600, "circle"), (836, "squircle")]:
        size = 200
        mask = Image.new("L", (size * 4, size * 4))
        if shape == "circle":
            ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        else:
            # Superellipse |x|^4 + |y|^4 <= 1, a launcher-like squircle preview.
            mask.putdata([255 if abs((x + .5) / (size * 2) - 1) ** 4 +
                          abs((y + .5) / (size * 2) - 1) ** 4 <= 1 else 0
                          for y in range(size * 4) for x in range(size * 4)])
        sheet.paste(render(size), (x, 88), mask.resize((size, size), Image.Resampling.LANCZOS))
        draw.text((x, 308), shape + " crop", fill="#202a2b", font=small)
    for x, size in [(600, 64), (720, 32), (824, 16)]:
        sheet.paste(render(size), (x, 400))
        draw.text((x, 490), f"{size} px", fill="#202a2b", font=small)
    draw.text((600, 560), "Warm ivory / bold charcoal IM", fill="#202a2b", font=small)
    draw.text((40, 716), "Central IM lettering. Circular seal. Same family as 2FA.", fill="#202a2b", font=font)
    draw.text((40, 752), "Artwork fits the central 80% safe circle. OS crops are previews, not installation proof.", fill="#516465", font=small)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Optional 1080 x 840 contact sheet")
    args = parser.parse_args()
    for relative, size in OUTPUTS.items():
        destination = PUBLIC / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        render(size).save(destination, optimize=True)
    # Multi-resolution conventional browser fallback; no external ICO tooling.
    render(48).save(PUBLIC / "favicon.ico", format="ICO",
                    sizes=[(16, 16), (32, 32), (48, 48)])
    if args.preview:
        contact_sheet(args.preview)


if __name__ == "__main__":
    main()
