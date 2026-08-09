"""Chroma-screen art -> transparent, palette-compressed game PNGs.

Reads raw Gemini output from C:\\ZINC\\art-drop and writes into the web app's
public folder. Keys out the solid backdrop (green OR red — detected per image
by sampling the border, because green characters like Pepe are shot on red),
despills the fringe JPEG leaves on outlines, crops to content, downscales with
NEAREST so the chunky pixels stay crunchy, and quantizes to a palette — the
source art is already limited-palette pixel art, so this is lossless to the
eye and cuts the payload by ~4x.

Tiles are rotated 90 degrees: Gemini draws pointy-top hexagons and the lattice
renders flat-top ones. A quarter turn is pixel-exact, so the silhouettes line
up with no resampling.
"""

import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

SRC = r"C:\ZINC\art-drop"
DST = r"C:\ZINC\apps\web\public"
POSES = {"head": 384, "win": 512, "lose": 512}
CHARS = ["chad", "soyjak", "wojak", "ansem", "saylor", "pepe", "chud", "bogdanoff", "bobo", "mumu", "milady", "sbf"]
TILES = ["base", "hairline", "heavy", "crack"]
TILE_SIZE = 384
COLORS = 96

# Speck floor for generations that came with scenery. Milady is drawn kneeling
# in spilled chips, cards and dice; most of that litter falls under the default
# 1%, but two cards clear it and leave her floating above debris while every
# other loser is alone on the ice. Raising the floor globally is not an option:
# Wojak's lose is line art whose eyes and nose are separate 1-2% strokes, and
# they are not enclosed by anything, so no containment test tells them apart
# from scenery either. Per image is the honest way to say it.
SPECK_FLOOR = {("milady", "lose"): 0.02}


def key_backdrop(img: Image.Image) -> Image.Image:
    """Removes the backdrop only — never colour that belongs to the character.

    A plain colour test cannot tell a green screen from a green frog, and ate
    Pepe alive. Two defences: green characters are shot on RED (#ff0000)
    instead, detected here by which chroma dominates the border; and the
    colour test only decides candidates — what actually gets removed is the
    candidate region CONNECTED TO THE BORDER. Character colour is enclosed by
    its own outline, so it can never be reached from outside.
    """
    img = img.convert("RGBA")
    a = np.asarray(img).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    # Generous: catches the JPEG smear that haloes every outline.
    keys = {
        "green": (g, r, b, (g > 90) & (g > r * 1.35) & (g > b * 1.35)),
        "red": (r, g, b, (r > 90) & (r > g * 1.35) & (r > b * 1.35)),
    }
    # The backdrop is whichever chroma owns the border of the frame.
    def border_share(mask: np.ndarray) -> float:
        return float(
            np.concatenate([mask[0, :], mask[-1, :], mask[:, 0], mask[:, -1]]).mean()
        )
    color = max(keys, key=lambda k: border_share(keys[k][3]))
    key, o1, o2, candidates = keys[color]

    labels, count = ndimage.label(candidates)
    bg = np.zeros(candidates.shape, dtype=bool)
    if count:
        edge = np.concatenate(
            [labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]
        )
        touching = np.unique(edge[edge > 0])
        if touching.size:
            bg = np.isin(labels, touching)

    # Pockets fully enclosed by the character (between an arm and a torso)
    # never touch the border, so they get a much stricter test of their own.
    bg |= (key > 200) & (o1 < 130) & (o2 < 130)

    out = np.asarray(img).copy()
    out[bg] = 0
    # Despill ONLY the pixels hugging the removed backdrop. Applied to the
    # whole image it clamps the key colour everywhere and turns Pepe olive:
    # key colour more than a pixel or two from the backdrop is the character's.
    fringe = ndimage.binary_dilation(bg, iterations=2) & ~bg
    others = np.maximum(o1, o2)
    cast = fringe & (key > others)
    ch = 1 if color == "green" else 0
    out[..., ch] = np.where(cast, others, out[..., ch])
    return Image.fromarray(out, "RGBA")


def trim(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    if not bbox:
        return img
    pad = max(2, int(0.01 * max(img.size)))
    return img.crop(
        (
            max(0, bbox[0] - pad),
            max(0, bbox[1] - pad),
            min(img.width, bbox[2] + pad),
            min(img.height, bbox[3] + pad),
        )
    )


def drop_specks(img: Image.Image, min_frac: float = 0.01) -> Image.Image:
    """Deletes anything that is not part of the character.

    Some generations come with a decorative border. The keyer eats the parts
    of it that sit on green and leaves the rest as fragments stranded at the
    edge of the frame, which then read as stray scratches on the ice. Every
    such fragment is its own island, so keeping only islands of a meaningful
    size relative to the subject removes them and leaves real detached pieces
    (a held phone, a raised fist) untouched.
    """
    a = np.asarray(img).copy()
    op = a[..., 3] > 8
    labels, n = ndimage.label(op)
    if n <= 1:
        return img
    sizes = np.asarray(ndimage.sum(op, labels, range(1, n + 1)))
    keep_ids = np.nonzero(sizes >= sizes.max() * min_frac)[0] + 1
    a[~np.isin(labels, keep_ids)] = 0
    return Image.fromarray(a, "RGBA")


def strip_frame(img: Image.Image, max_frac: float = 0.04) -> Image.Image:
    """Shaves the decorative border some generations draw around the art.

    The keyer only removes green, so a dark frame drawn around the character
    survives it and shows up as stray lines along the plate edge. A frame is a
    near-solid run of opaque pixels spanning a whole edge, so peel those off —
    bounded, because a character can legitimately touch the edge.
    """
    a = np.asarray(img)
    op = a[..., 3] > 8
    h, w = op.shape
    top, bottom, left, right = 0, h, 0, w
    vlim, hlim = int(h * max_frac) + 1, int(w * max_frac) + 1
    while top < vlim and op[top, left:right].mean() > 0.85:
        top += 1
    while (h - bottom) < vlim and op[bottom - 1, left:right].mean() > 0.85:
        bottom -= 1
    while left < hlim and op[top:bottom, left].mean() > 0.85:
        left += 1
    while (w - right) < hlim and op[top:bottom, right - 1].mean() > 0.85:
        right -= 1
    if (left, top, right, bottom) == (0, 0, w, h):
        return img
    return img.crop((left, top, right, bottom))


def fit(img: Image.Image, target: int) -> Image.Image:
    if max(img.size) <= target:
        return img
    s = target / max(img.size)
    return img.resize(
        (max(1, round(img.width * s)), max(1, round(img.height * s))), Image.NEAREST
    )


def save(img: Image.Image, path: str) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # FASTOCTREE is the quantizer that keeps the alpha channel intact.
    img.quantize(colors=COLORS, method=Image.Quantize.FASTOCTREE).save(
        path, optimize=True
    )
    return os.path.getsize(path) // 1024


def find(folder: str, stem: str) -> str | None:
    if not os.path.isdir(folder):
        return None
    for f in sorted(os.listdir(folder)):
        if stem in f.lower() and f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            return os.path.join(folder, f)
    return None


def do_chars() -> int:
    total = 0
    for char in CHARS:
        for pose, target in POSES.items():
            src = find(os.path.join(SRC, char), pose)
            if not src:
                continue
            floor = SPECK_FLOOR.get((char, pose), 0.01)
            keyed = drop_specks(key_backdrop(Image.open(src)), floor)
            img = trim(strip_frame(trim(keyed)))
            if pose == "head":
                # The lattice blits heads square; pad rather than squash.
                side = max(img.size)
                sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
                img = sq
            img = fit(img, target)
            kb = save(img, os.path.join(DST, "chars", char, f"{pose}.png"))
            total += kb
            print(f"  {char}/{pose}: {img.width}x{img.height}  {kb} KB")
    return total


def do_tiles() -> int:
    total = 0
    for name in TILES:
        src = find(os.path.join(SRC, "tiles"), name)
        if not src:
            continue
        img = key_backdrop(Image.open(src))
        # Pointy-top source -> flat-top lattice. Exactly a quarter turn.
        img = fit(trim(img.transpose(Image.ROTATE_90)), TILE_SIZE)
        kb = save(img, os.path.join(DST, "tiles", f"{name}.png"))
        total += kb
        print(f"  tiles/{name}: {img.width}x{img.height}  {kb} KB")
    return total


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    total = 0
    if what in ("all", "chars"):
        total += do_chars()
    if what in ("all", "tiles"):
        total += do_tiles()
    print(f"total {total} KB")
