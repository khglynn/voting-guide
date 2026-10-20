"""Turn Cycles renders into the site's paper assets, light and dark.

    python3 -I scripts/paper/bake.py RENDER_DIR [PIECE,...]     (run from the repo root)

Writes public/paper/<name>.webp and public/paper/dark/<name>.webp, and the paper variables between the
/* paper:start */ and /* paper:end */ markers in src/styles.css. With a list of pieces (plan, strips, sheet,
crowd, pile) it bakes only those, so one new render doesn't re-bake the rest; the paper variables are
rewritten only when both plan and sheet are baked, since they come from those two.

- Shadow pixels from the shadow catcher are tinted to the page ink and capped, so no edge gets a hard
  black line. It fails if a real dark line survives.
- Everything is drawn as plain background images, never border-image: Safari scales border-image
  slices roughly, and a 2x render upscaled on a 3x iPhone showed stair-stepped edges (Oct 20).
- The plan notice is a torn top band and a torn bottom band; between them a CSS gradient sampled from
  the render's flat middle continues its light at any height. The check below makes sure those middle
  rows really are flat. The cheat sheet's torn top works the same way.
- The strips are one image each, scaled as a whole to the header's height (no slices, so the cut
  end stays one straight line).
- The dark set is derived from the same renders: paper scaled to the dark tokens, white fiber cores
  pulled down to a quiet green grey, shadows lighter.
"""
import sys, os, re
import numpy as np
from PIL import Image
R = sys.argv[1]
ONLY = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else {'plan', 'strips', 'sheet', 'crowd', 'pile'}
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
    # A baked black edge runs along the paper's outline, next to the desk. Deep green paper in the shade where
    # one sheet of the pile lies over another is dark too, but it sits inside the paper, so it doesn't count.
    bad = (a[..., :3].max(-1) < 40) & (a[..., 3] > 150) & (box((a[..., 3] < 250).astype(float), 2) > 0)
    assert bad.sum() < 40, 'dark opaque pixels left: %d' % bad.sum()   # a baked black edge is hundreds
    return a

def box(x, r):
    """Mean over a (2r+1) square window, by summed-area table (no scipy needed)."""
    p = np.pad(x, ((r + 1, r), (r + 1, r)) + ((0, 0),) * (x.ndim - 2), mode='edge').cumsum(0).cumsum(1)
    n = 2 * r + 1
    return (p[n:, n:] - p[:-n, n:] - p[n:, :-n] + p[:-n, :-n])

def defringe(a, r=5):
    """Where the paper's edge meets its own contact shadow, Cycles blends the edge pixels with the near-black
    shadow under them: a dark, nearly opaque line one or two pixels wide along every cut edge. On a slanted edge
    it steps row by row and reads as jagged teeth once a phone upscales it (Kevin, Oct 20). The shadow adds no
    light, so a pixel's brightness over the nearby paper's is how much of it is paper: give it the paper's own
    color with that coverage as alpha. Pixels that are almost all shadow stay for soften() to tint."""
    a = a.copy(); al = a[..., 3]
    near_clear = box((al < 250).astype(float), 2) > 0
    inner = ((al == 255) & ~near_clear).astype(float)
    cnt = box(inner, r)
    local = box(a[..., :3] * inner[..., None], r) / np.maximum(cnt, 1e-6)[..., None]
    lum, loc = a[..., :3].mean(-1), local.mean(-1)
    c = np.clip(lum / np.maximum(loc, 1e-6), 0, 1)
    fix = (al >= 100) & (inner == 0) & (cnt > 0) & (lum < .92 * loc) & (c >= .15)
    a[fix, :3] = local[fix]; a[fix, 3] = np.minimum(al[fix], 255 * c[fix])
    print('  defringed %d edge pixels' % fix.sum())
    return a

def soft_contact(a):
    """The contact shadow just outside a cut edge is a crisp one-pixel line, and it steps too: average the
    shadow's alpha over its 3x3 neighborhood so the line goes soft."""
    a = a.copy()
    sh = (np.abs(a[..., :3] - INK).max(-1) < 2) & (a[..., 3] < 255)
    soft = box(np.where(sh, a[..., 3], 0.0), 1) / 9
    a[sh, 3] = np.minimum(a[sh, 3], np.maximum(soft[sh], a[sh, 3] * .6))
    return a

def darken(a, k, core_to=None, sh=.45, pale=None):
    """pale: scale pale paper (cream, white fiber) by this instead of k, so it doesn't glare on a dark page."""
    a = a.copy(); paper = a[..., 3] > 0
    shadow = (np.abs(a[..., :3] - INK).max(-1) < 2) & (a[..., 3] < 255)
    rgb = a[..., :3] * np.array(k)
    if core_to is not None or pale is not None:
        lum = a[..., :3].mean(-1) / 255; sat = (a[..., :3].max(-1) - a[..., :3].min(-1)) / 255
        t = np.clip(((lum - .45) / .35) if core_to is not None else ((lum - .7) / .15), 0, 1) * (sat < .12)   # pale: not the green tint
        to = np.array(core_to, float) if core_to is not None else a[..., :3] * pale
        rgb = rgb * (1 - t[..., None]) + to * t[..., None]
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
    d = a.shape[1] / 640                                  # device px per CSS px: 2 for a 2x render, 3 for 3x
    for x in range(0, a.shape[1], int(20 * d)):
        px = a[row - 3:row + 4, max(0, x - 6):x + 7]; px = px[px[..., 3] == 255][:, :3]
        if len(px): stops.append('%s %dpx' % (hexc(np.median(px, 0) * np.array(k)), round(x / d)))
    return 'linear-gradient(90deg, %s)' % ', '.join(stops)

kb = {}
light, dark = {}, {}
if 'plan' in ONLY:
    a = soft_contact(soften(defringe(load('plan')))); flat_rows(a, 200, a.shape[0] - 200, 'plan')
    ad = darken(a, GREEN_K, GREEN_CORE); mid = a.shape[0] // 2
    kb['plan-top'] = save(a[:200], os.path.join(OUT, 'plan-top.webp')); save(ad[:200], os.path.join(OUTD, 'plan-top.webp'))
    kb['plan-bot'] = save(a[-200:], os.path.join(OUT, 'plan-bot.webp')); save(ad[-200:], os.path.join(OUTD, 'plan-bot.webp'))
    light['--plan-fill'] = gradient(a, mid); dark['--plan-fill'] = gradient(ad, mid)
if 'strips' in ONLY:
    for n in ('strip-a', 'strip-b', 'strip-c', 'strip-d'):
        a = soft_contact(soften(defringe(load(n))))           # scaled whole, so no flat-middle check
        kb[n] = save(a, os.path.join(OUT, n + '.webp')); save(darken(a, GREEN_K, GREEN_CORE), os.path.join(OUTD, n + '.webp'))
if 'sheet' in ONLY:
    a = soft_contact(soften(defringe(load('sheet')))); row = 180
    light['--sheet-fill'] = gradient(a, row); dark['--sheet-fill'] = gradient(a, row, SHEET_K)
    mid = np.median(a[row - 3:row + 4, 600:680, :3].reshape(-1, 3), 0)
    light['--sheet-paper'] = hexc(mid); dark['--sheet-paper'] = hexc(mid * np.array(SHEET_K))
    kb['sheet'] = save(a, os.path.join(OUT, 'sheet.webp')); save(darken(a, SHEET_K), os.path.join(OUTD, 'sheet.webp'))
if 'crowd' in ONLY:
    a = soft_contact(soften(defringe(load('crowd'))))
    kb['crowd'] = save(a, os.path.join(OUT, 'crowd.webp')); save(darken(a, (.86, .86, .86)), os.path.join(OUTD, 'crowd.webp'))
if 'pile' in ONLY:
    a = soft_contact(soften(defringe(load('pile'))))
    kb['pile'] = save(a, os.path.join(OUT, 'pile.webp')); save(darken(a, (.86, .86, .86), pale=.6), os.path.join(OUTD, 'pile.webp'))

def block(sel, d): return '%s { %s }' % (sel, ' '.join('%s: %s;' % kv for kv in d.items()))
if {'plan', 'sheet'} <= ONLY:
    css = '/* paper:start (written by scripts/paper/bake.py) */\n%s\n@media (prefers-color-scheme: dark) { %s }\n%s\n/* paper:end */' % (
        block(':root', light), block(':root:not([data-theme="light"])', dark), block(':root[data-theme="dark"]', dark))
    s = open(CSS, encoding='utf-8').read()
    assert '/* paper:start' in s, 'add the /* paper:start */ /* paper:end */ markers to src/styles.css first'
    s = re.sub(r'/\* paper:start.*?/\* paper:end \*/', lambda m: css, s, flags=re.S)
    open(CSS, 'w', encoding='utf-8').write(s)
print('KB', kb, 'total', sum(kb.values()))
