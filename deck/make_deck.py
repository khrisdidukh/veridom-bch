"""Fills the official BCH BLAZE "Widget Factory" template with the Veridom Escrow content.

    python3 deck/make_deck.py [story-image.png]

Keeps the template's layout, theme and artwork; replaces texts, the logo, the story picture
and the code picture. Output: deck/veridom-escrow-deck.pptx (convert to PDF with LibreOffice).
"""
import copy, io, sys, pathlib
from pptx import Presentation
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
REPO = 'https://github.com/khrisdidukh/veridom-bch'
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

def set_paragraphs(shape, lines):
    """lines: list of str or (str, level). Reuses the template's paragraph/run formatting."""
    tf = shape.text_frame
    paras = list(tf.paragraphs)
    by_level = {}
    for p in paras:
        if p.runs and p.level not in by_level: by_level[p.level] = p._p
    out = []
    for item in lines:
        text, level = item if isinstance(item, tuple) else (item, 0)
        el = copy.deepcopy(by_level.get(level, by_level[min(by_level)]))
        out.append((el, text))
    body = tf._txBody
    for p in paras: body.remove(p._p)
    for el, text in out:
        body.append(el)
        runs = [r for r in el if r.tag.endswith('}r')]
        for r in runs[1:]: el.remove(r)
        for br in [b for b in el if b.tag.endswith('}br')]: el.remove(br)
        runs[0].find('{http://schemas.openxmlformats.org/drawingml/2006/main}t').text = text

def replace_picture(slide, shape, image, fit=None):
    """Swap the picture's bytes; keep position. `image` is a PIL image."""
    buf = io.BytesIO(); image.convert('RGB').save(buf, 'PNG')
    rid = shape._element.blipFill.blip.rEmbed
    part = slide.part.related_part(rid)
    part._blob = buf.getvalue()

def logo(size=1200):
    im = Image.new('RGB', (size, size), '#14213d'); d = ImageDraw.Draw(im); s = size / 64
    d.line([(12*s, 34*s), (32*s, 14*s), (52*s, 34*s)], fill='#f4efe6', width=int(5*s), joint='curve')
    for y, w, c in ((36, 26, '#0ac18e'), (44, 26, '#f4efe6'), (52, 12, '#ff7a1a')):
        d.rounded_rectangle([19*s, y*s, (19+w)*s, (y+5)*s], radius=int(1.5*s), fill=c)
    return im

CODE = '''function release(pubkey approver, sig approval) {
    require(approver == owner || approver == inspector);
    require(checkSig(approval, approver));
    int retained = value * retentionBps / 10000;
    require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(hash160(contractor)));
    require(tx.outputs[1].lockingBytecode == retentionLock);
    require(tx.outputs[0].value == value - retained);   // builder is paid
    require(tx.outputs[1].value == retained);           // retention goes to the vault
}'''

def code_image(w=2640, h=900):
    im = Image.new('RGB', (w, h), '#fbfaf7'); d = ImageDraw.Draw(im)
    font = ImageFont.truetype(MONO, 40)
    y = 60
    for line in CODE.split('\n'):
        code, _, comment = line.partition('//')
        d.text((60, y), code, font=font, fill='#14213d')
        if comment: d.text((60 + d.textlength(code, font=font), y), '//' + comment, font=font, fill='#0a9e75')
        y += 86
    return im

def square(path):
    im = Image.open(path); w, h = im.size; s = min(w, h)
    return im.crop(((w - s) // 2, 0, (w - s) // 2 + s, s)).resize((1400, 1400))

prs = Presentation(HERE / 'template-widget-factory.pptx')
s = list(prs.slides)
by_id = lambda slide: {sh.shape_id: sh for sh in slide.shapes}

a = by_id(s[0])
set_paragraphs(a[58], ['Veridom Escrow'])
set_paragraphs(a[70], ['Solo builder: Khrystyna Didukh, founder of Veridom'])
set_paragraphs(a[60], ['veridom.space'])
set_paragraphs(a[62], ['KhDidukh'])
for i in (61, 64, 65): a[i]._element.getparent().remove(a[i]._element)   # no Telegram handle
replace_picture(s[0], a[71], logo())

b = by_id(s[1])
tf = b[78].text_frame
texts = ['', 'Pay your builder stage by stage. The chain holds the money, not a promise.', REPO]
filled = [p for p in tf.paragraphs if any(r.text.strip() for r in p.runs)]
head = filled[0].runs
head[0].text = 'Veridom '; head[1].text = 'Escrow'
for r in head[2:]: r.text = ''
filled[1].runs[0].text = texts[1]
for r in filled[1].runs[1:]: r.text = ''
filled[2].runs[0].text = REPO
for r in filled[2].runs[1:]: r.text = ''
if filled[2].runs[0].hyperlink is not None: filled[2].runs[0].hyperlink.address = REPO

c = by_id(s[2])
set_paragraphs(c[95], ['The Story of Veridom Escrow'])
set_paragraphs(c[93], [
    'Every building contract has the same weak spot: money moves on trust. Pay early and the builder may vanish. Pay late and the builder carries your risk.',
    'Banks answer with guarantees and notary accounts - far too heavy for a bathroom refit or a garden studio.',
    'Veridom helps private homebuilders control their build. For BLAZE I asked: what if the payment schedule itself lived on Bitcoin Cash? Two covenants later, it does.',
])
if len(sys.argv) > 1: replace_picture(s[2], c[98], square(sys.argv[1]))

d_ = by_id(s[3])
set_paragraphs(d_[107], ['Benefits of Veridom Escrow'])
set_paragraphs(d_[108], [
    'Money is locked per building stage',
    ('The builder sees it before starting work', 1),
    ('The homeowner keeps control until approval', 1),
    'Approve and the builder is paid in seconds, for a fee under a cent',
    'The warranty retention is enforced by a script',
    ('After the warranty date it can only go to the builder', 1),
    'BCH or ParyonUSD stablecoin. No server, no account: one link is the agreement',
])

e = by_id(s[4])
paras = [p for p in e[116].text_frame.paragraphs if any(r.text.strip() for r in p.runs)]   # title 'BCH Usage' stays
usage = ['Two CashScript covenants: each stage is its own UTXO; approval forces the split between builder and a time-locked retention vault.',
         'CashTokens for stablecoin stages (PUSD), WizardConnect for signing. Real BCH mainnet transactions from your own wallet.']
for p, t in zip(paras[1:], usage):
    p.runs[0].text = t
    for r in p.runs[1:]: r.text = ''
replace_picture(s[4], e[117], code_image())

f = by_id(s[5])
set_paragraphs(f[126], ['The Vision for Veridom Escrow'])
set_paragraphs(f[127], [
    'Today: a working escrow, proven on chipnet and ready for mainnet, 31 covenant tests',
    'Next: partial settlements, photo evidence hashed into every approval',
    'Then: built into the Veridom app',
    ('Stages come straight from the construction schedule', 1),
    ('Planned revenue: a small fee per released stage', 1),
    'Goal: every private build and renovation paid stage by stage on BCH',
])

prs.save(HERE / 'veridom-escrow-deck.pptx')
print('saved', HERE / 'veridom-escrow-deck.pptx')
