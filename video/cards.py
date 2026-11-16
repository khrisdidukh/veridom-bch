"""Intro and outro cards for the demo video (1920x1080 PNG).

    python3 video/cards.py <out-dir>
"""
import sys, pathlib
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'video/out')
OUT.mkdir(parents=True, exist_ok=True)
F = '/usr/share/fonts/opentype/inter/'
PAPER, INK, SOFT, GO, HOLD = '#f4efe6', '#14213d', '#4a5673', '#0a9e75', '#c2570a'
W, H = 1920, 1080


def font(name, size):
    return ImageFont.truetype(F + name, size)


def base():
    im = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(im)
    for x in range(0, W, 40):
        d.line([(x, 0), (x, H)], fill='#ebe5da')
    for y in range(0, H, 40):
        d.line([(0, y), (W, y)], fill='#ebe5da')
    d.rectangle([0, 0, W, 56], fill=INK)
    d.text((W // 2, 28), 'BCH BLAZE 2026  ·  Mainnet Track', font=font('InterDisplay-SemiBold.otf', 26), fill='#ff9a4a', anchor='mm')
    return im, d


def logo(d, x, y, s=2.2):
    d.rounded_rectangle([x, y, x + 64 * s, y + 64 * s], radius=int(12 * s), fill=INK)
    d.line([(x + 12 * s, y + 34 * s), (x + 32 * s, y + 14 * s), (x + 52 * s, y + 34 * s)], fill=PAPER, width=int(5 * s), joint='curve')
    for yy, w, c in ((36, 26, GO), (44, 26, PAPER), (52, 12, '#ff7a1a')):
        d.rounded_rectangle([x + 19 * s, y + yy * s, x + (19 + w) * s, y + (yy + 5) * s], radius=int(1.5 * s), fill=c)


im, d = base()
logo(d, 160, 170)
d.text((340, 190), 'Veridom Escrow', font=font('InterDisplay-Bold.otf', 64), fill=INK)
d.text((340, 268), 'a new module of Veridom, the house-building control app', font=font('Inter-Regular.otf', 30), fill=SOFT)
d.text((160, 400), 'Pay your builder stage by stage.', font=font('InterDisplay-ExtraBold.otf', 80), fill=INK)
d.text((160, 500), 'The chain holds the money, not a promise.', font=font('InterDisplay-ExtraBold.otf', 80), fill=INK)
rows = [
    (GO, 'Each building stage is locked in its own CashScript covenant'),
    (GO, 'Approve a stage: the covenant pays the builder, retention goes to a time-locked vault'),
    (HOLD, 'Warranty over: the retention can only go to the builder. Nobody can stall it'),
    (INK, 'Disputes: any 2 of 3 (homeowner, builder, inspector) decide together'),
]
y = 680
for c, t in rows:
    d.ellipse([160, y + 8, 184, y + 32], fill=c)
    d.text((208, y), t, font=font('Inter-Medium.otf', 34), fill=INK)
    y += 66
im.save(OUT / 'intro.png')

im, d = base()
logo(d, 160, 170)
d.text((340, 190), 'Veridom Escrow', font=font('InterDisplay-Bold.otf', 64), fill=INK)
d.text((340, 268), 'Try it on mainnet with your own wallet', font=font('Inter-Regular.otf', 30), fill=SOFT)
lines = [
    ('Live demo', 'khrisdidukh.github.io/veridom-bch'),
    ('Source code', 'github.com/khrisdidukh/veridom-bch'),
    ('Wallets', 'Cashonize, Paytaca and other WizardConnect wallets'),
    ('Pay in', 'BCH or ParyonUSD (CashTokens)'),
    ('Proof', '39 automated tests · full life cycle on chipnet'),
]
y = 400
for k, v in lines:
    d.text((160, y), k, font=font('InterDisplay-SemiBold.otf', 36), fill=SOFT)
    d.text((520, y), v, font=font('InterDisplay-Bold.otf', 40), fill=INK)
    y += 82
d.text((160, 880), 'Open source · no server · no custody · fees under a cent', font=font('Inter-Medium.otf', 34), fill=GO)
d.text((160, 940), 'Built by Khrystyna Didukh, founder of Veridom (veridom.space)', font=font('Inter-Regular.otf', 30), fill=SOFT)
im.save(OUT / 'outro.png')
print('cards in', OUT)
