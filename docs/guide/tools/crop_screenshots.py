"""Turn the raw screenshots from `npm run e2e -- <dir>` into the images the guide uses.

Usage: python docs/guide/tools/crop_screenshots.py <raw-dir> <out-dir>

Each image is cropped one of three ways:
- "collapse": full-page review shots, with the tall empty band above the
  sticky Log button squeezed down and the side margins trimmed;
- "trim": cut to the content's bounding box (optionally from a given top);
- "copy": popup-sized shots, kept as they are.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops

# image name -> (mode, option)
IMAGES = {
    "review.png": ("collapse", None),
    "review-open.png": ("collapse", None),
    "review-ai.png": ("collapse", None),
    "review-summary.png": ("collapse", None),
    "review-summary-ai.png": ("collapse", None),
    "review-question.png": ("collapse", None),
    "review-other-day.png": ("collapse", None),
    "review-week.png": ("collapse", None),
    "settings.png": ("trim", 0),
    "calendar-date.png": ("trim", 0),
    "tickets.png": ("trim", 0),
    "tickets-collapsed.png": ("trim", 0),
    # Only the day list, not the month grid above it.
    "calendar-move.png": ("trim", 525),
    "popup.png": ("copy", None),
    "popup-dark.png": ("copy", None),
    "popup-tickets.png": ("copy", None),
    "popup-calendar.png": ("copy", None),
}

MAX_BLANK_ROWS = 36
SIDE_TRIM = 56
PAD = 24


def background(im: Image.Image) -> tuple:
    return im.getpixel((5, im.height - 5))


def collapse(im: Image.Image) -> Image.Image:
    width, height = im.size
    bg = background(im)
    px = im.load()
    keep, run = [], 0
    for y in range(height):
        blank = all(px[x, y] == bg for x in range(0, width, 2))
        run = run + 1 if blank else 0
        if run <= MAX_BLANK_ROWS:
            keep.append(y)
    out = Image.new("RGB", (width, len(keep)))
    for i, y in enumerate(keep):
        out.paste(im.crop((0, y, width, y + 1)), (0, i))
    return out.crop((SIDE_TRIM, 0, width - SIDE_TRIM, out.height))


def trim(im: Image.Image, top: int) -> Image.Image:
    bbox = ImageChops.difference(im, Image.new("RGB", im.size, background(im))).getbbox()
    if not bbox:
        return im
    left, upper, right, lower = bbox
    return im.crop((max(0, left - PAD), max(top, upper - PAD), min(im.width, right + PAD), min(im.height, lower + PAD)))


def main(raw_dir: Path, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    missing = []
    for name, (mode, option) in IMAGES.items():
        src = raw_dir / name
        if not src.exists():
            missing.append(name)
            continue
        im = Image.open(src).convert("RGB")
        if mode == "collapse":
            im = collapse(im)
        elif mode == "trim":
            im = trim(im, option)
        im.save(out_dir / name, optimize=True)
        print(f"{name}: {im.width}x{im.height}")
    if missing:
        print("missing from the e2e run (left unchanged):", ", ".join(missing), file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
