# Mirkwood's icons. Run with `py -3 tools/mk-icons.py` (needs Pillow; on
# Windows the runic glyph lives in Segoe UI Historic, NOT Segoe UI Symbol,
# which renders U+16D7 as tofu).
#
# Two KINDS of asset, and the difference is the whole point:
#
#   The app icons are OPAQUE. Apple requires it (an alpha channel in a Home
#   Screen icon gets composited against a solid fill, which is how logos end up
#   as white-on-white), and a maskable icon has to bleed to the edge anyway.
#
#   The notification BADGE is the exact opposite: nothing but alpha. Android
#   draws the status-bar small icon from the alpha channel ALONE, discards R/G/B
#   entirely, and fills the resulting mask with flat white. Hand it an opaque
#   square and every pixel is alpha=255, so the mask is the whole square and you
#   get a solid white blob with no rune in it. That is not a degraded icon, it
#   is the documented behaviour of feeding it the wrong kind of image.
#
# So one file cannot serve both, and this is not a matter of taste. Keep the
# ember glow out of the badge too: a soft alpha gradient masks into a grey
# smear rather than a glyph.
from PIL import Image, ImageDraw, ImageFont

BG = (10, 16, 13, 255)                   # --bg   #0a100d
GOLD = (232, 178, 60)                    # --gold #e8b23c
FONT = r"C:\Windows\Fonts\seguihis.ttf"  # Segoe UI Historic carries the Runic block
MANNAZ = "ᛗ"                        # the brand mark
OUT = r"E:\Claude\mirkwood\public"


def app_icon(size, out):
    """Full-colour, OPAQUE: gold rune on the forest dark, with an ember glow.
    Full-bleed so the maskable variant survives any launcher shape."""
    img = Image.new("RGBA", (size, size), BG)
    # radial glow on its OWN layer: ImageDraw replaces pixels rather than
    # blending, so the gradient is built by concentric overwrites then
    # composited once
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx = cy = size / 2
    steps, max_r = 60, size * 0.44
    for i in range(steps, 0, -1):
        r = max_r * i / steps
        gd.ellipse([cx - r, cy - r, cx + r, cy + r],
                   fill=GOLD + (int(60 * (1 - i / steps) ** 1.6),))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * 0.56))
    box = d.textbbox((0, 0), MANNAZ, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text((cx - w / 2 - box[0], cy - h / 2 - box[1]), MANNAZ, font=font, fill=GOLD + (255,))
    img.convert("RGB").save(out, "PNG")   # drop alpha: Apple wants opaque
    print("app icon ", out, size)


def badge(out, size=96, pad=10, sup=8):
    """Alpha-only silhouette for Notification `badge:`.

    96px = 24dp at 4x (MDN's ceiling), and downscales cleanly to 72/48/24.

    Drawn into an L-mode (alpha-only) canvas, which sidesteps ImageDraw's
    replace-not-blend behaviour entirely: there is no colour here to get wrong.
    """
    mask = Image.new("L", (size * sup, size * sup), 0)
    ImageDraw.Draw(mask).text(
        (size * sup // 2, size * sup // 2), MANNAZ,
        font=ImageFont.truetype(FONT, 500), fill=255, anchor="mm")
    # crop to the INK, not the text box: font side bearings would leave the
    # glyph off-centre and undersized
    ink = mask.crop(mask.getbbox())
    w, h = ink.size
    k = min((size - 2 * pad) / w, (size - 2 * pad) / h)   # fit, keep aspect
    ink = ink.resize((round(w * k), round(h * k)), Image.LANCZOS)

    alpha = Image.new("L", (size, size), 0)
    alpha.paste(ink, ((size - ink.size[0]) // 2, (size - ink.size[1]) // 2))
    img = Image.new("RGBA", (size, size), (255, 255, 255, 255))  # white...
    img.putalpha(alpha)                                          # ...shaped by alpha alone
    img.save(out, optimize=True)
    print("badge    ", out, size, "| ink", ink.size)


if __name__ == "__main__":
    import sys
    # default: only the badge, so a stray run cannot churn the shipped app
    # icons. Pass --all to rebuild everything.
    if "--all" in sys.argv:
        app_icon(512, OUT + r"\icon-512.png")
        app_icon(192, OUT + r"\icon-192.png")
        app_icon(180, OUT + r"\apple-touch-icon.png")
    badge(OUT + r"\badge-96.png")
