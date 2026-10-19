"""Turn Cycles renders into the site's paper assets, light and dark.

    python3 -I scripts/paper/bake.py RENDER_DIR            (run from the repo root)

Writes public/paper/<name>.webp and public/paper/dark/<name>.webp, and the paper variables between the
/* paper:start */ and /* paper:end */ markers in src/styles.css.

- Shadow pixels from the shadow catcher are tinted to the page ink and capped, so no edge gets a hard
  black line. It fails if a real dark line survives.
- The plan and the strips are drawn with CSS border-image, which stretches their middle rows to any
  height; it checks those rows really are flat from top to bottom.
- The cheat sheet's torn top is a band; its fill continues the render's light as a CSS gradient sampled
  from the band's flat rows.
- The dark set is derived from the same renders: paper scaled to the dark tokens, white fiber cores
  pulled down to a quiet green grey, shadows lighter.
"""
import sys, os, re
import numpy as np
from PIL import Image
R = sys.argv[1]
OUT = 'public/paper'; OUTD = os.path.join(OUT, 'dark'); os.makedirs(OUTD, exist_ok=True)
CSS = 'src/styles.css'
INK = np.array([31, 38, 35], float)
GREEN_K = (0x38 / 0x41, 0x5C / 0x6E, 0x52 / 0x62); GREEN_CORE = (110, 130, 121)
SHEET_K = (212 / 242, 204 / 240, 186 / 235)

def load(n):
    return np.asarray(Image.open(os.path.join(R, n + '.png')).convert('RGBA')).astype(float)

def soften(a, cap=90, k=.55):
    a = a.copy(); sh = (a[..., :3].max(-1) < 40) & (a[..., 3] < 255)
    a[sh, :3] = INK; a[sh, 3] = np.minimum(a[sh, 3] * k, cap)
    bad = (a[..., :3].max(-1) < 40) & (a[..., 3] > 150)
    assert bad.sum() < 40, 'dark opaque pixels left: %d' % bad.sum()   # a baked black edge is hundreds
    return a

def darken(a, k, core_to=None, sh=.45):
    a = a.copy(); paper = a[..., 3] > 0
    shadow = (np.abs(a[..., :3] - INK).max(-1) < 2) & (a[..., 3] < 255)
    rgb = a[..., :3] * np.array(k)
    if core_to is not None:
        lum = a[..., :3].mean(-1) / 255; sat = (a[..., :3].max(-1) - a[..., :3].min(-1)) / 255
        t = np.clip((lum - .45) / .35, 0, 1) * (sat < .12)
        rgb = rgb * (1 - t[..., None]) + np.array(core_to, float) * t[..., None]
    a[..., :3] = np.where(paper[..., None] & ~shadow[..., None], rgb, a[..., :3])
    a[shadow, 3] *= sh
    return a

def save(a, path, q=86):
    Image.fromarray(np.clip(a + .5, 0, 255).astype(np.uint8), 'RGBA').save(path, quality=q, method=6)
    return round(os.path.getsize(path) / 1024)

def flat_rows(a, y0, y1, name):
    """The rows CSS will stretch: each column should not change from top to bottom."""
    blk = a[y0:y1, 40:-40]; opaque = blk[..., 3].min(0) == 255
    spread = float(np.abs(blk[:, opaque, :3] - blk[:, opaque, :3].mean(0)).max()) if opaque.any() else 0.0
    print('%s: middle rows %d..%d vary by up to %.1f levels' % (name, y0, y1, spread))
    assert spread < 6, '%s middle is not flat enough to stretch' % name

def hexc(c): return '#%02X%02X%02X' % tuple(int(round(v)) for v in c)
def gradient(a, row, k=(1, 1, 1)):
    stops = []
    for x in range(0, a.shape[1], 40):
        px = a[row - 3:row + 4, max(0, x - 6):x + 7]; px = px[px[..., 3] == 255][:, :3]
        if len(px): stops.append('%s %dpx' % (hexc(np.median(px, 0) * np.array(k)), x // 2))
    return 'linear-gradient(90deg, %s)' % ', '.join(stops)

kb = {}
light, dark = {}, {}
a = soften(load('plan')); flat_rows(a, 200, a.shape[0] - 200, 'plan')
kb['plan'] = save(a, os.path.join(OUT, 'plan.webp')); save(darken(a, GREEN_K, GREEN_CORE), os.path.join(OUTD, 'plan.webp'))
for n in ('strip-a', 'strip-b', 'strip-c', 'strip-d'):
    a = soften(load(n)); flat_rows(a, 80, 120, n)
    kb[n] = save(a, os.path.join(OUT, n + '.webp')); save(darken(a, GREEN_K, GREEN_CORE), os.path.join(OUTD, n + '.webp'))
a = soften(load('sheet')); row = 180
light['--sheet-fill'] = gradient(a, row); dark['--sheet-fill'] = gradient(a, row, SHEET_K)
mid = np.median(a[row - 3:row + 4, 600:680, :3].reshape(-1, 3), 0)
light['--sheet-paper'] = hexc(mid); dark['--sheet-paper'] = hexc(mid * np.array(SHEET_K))
kb['sheet'] = save(a, os.path.join(OUT, 'sheet.webp')); save(darken(a, SHEET_K), os.path.join(OUTD, 'sheet.webp'))
a = soften(load('crowd'))
kb['crowd'] = save(a, os.path.join(OUT, 'crowd.webp')); save(darken(a, (.86, .86, .86)), os.path.join(OUTD, 'crowd.webp'))

def block(sel, d): return '%s { %s }' % (sel, ' '.join('%s: %s;' % kv for kv in d.items()))
css = '/* paper:start (written by scripts/paper/bake.py) */\n%s\n@media (prefers-color-scheme: dark) { %s }\n%s\n/* paper:end */' % (
    block(':root', light), block(':root:not([data-theme="light"])', dark), block(':root[data-theme="dark"]', dark))
s = open(CSS, encoding='utf-8').read()
assert '/* paper:start' in s, 'add the /* paper:start */ /* paper:end */ markers to src/styles.css first'
s = re.sub(r'/\* paper:start.*?/\* paper:end \*/', lambda m: css, s, flags=re.S)
open(CSS, 'w', encoding='utf-8').write(s)
print('KB', kb, 'total', sum(kb.values()))
