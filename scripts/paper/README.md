# Paper

The guide's paper (the torn green notice for your next step, the cut green section strips, the cheat sheet torn off a pad, the crowd on the share step, the covered states piled at the foot of the first page) is rendered once, offline, with Blender's Cycles path tracer, and shipped as WebP images. The browser only draws flat images; the light, the paper thickness, the white fiber where green paper tears and the soft shadows come from the render.

```sh
python3 -m venv .tmp/bl && .tmp/bl/bin/pip install bpy scikit-image      # Blender 5.2 as a Python module, about 1 GB
.tmp/bl/bin/python scripts/paper/render.py .tmp/paper plan,sheet,crowd 48
PX=300 SUN_ANGLE=40 .tmp/bl/bin/python scripts/paper/render.py .tmp/paper strip-a,strip-b,strip-c,strip-d 48   # strips: 3x, softer sun
mkdir -p .tmp/ne && curl -sSo .tmp/ne/states.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_1_states_provinces_lakes.geojson
PX=300 STATES=.tmp/ne/states.geojson .tmp/bl/bin/python scripts/paper/render.py .tmp/paper pile 48   # 3x, about 90 s
.tmp/bl/bin/python -I scripts/paper/bake.py .tmp/paper                     # needs numpy and Pillow; the venv has both
.tmp/bl/bin/python -I scripts/paper/bake.py .tmp/paper pile                # or bake only the pieces you re-rendered
```

The Linux `bpy` wheels are x86_64 only, and each works with one Python version (`bpy` 5.2 needs `python3.13`). Two runs of the pile job on one machine gave identical pixels (Oct 20).

`render.py` builds each piece as real geometry (a torn or scissor-cut outline, a mesh, a lift-only crumple near the edges, Solidify thickness, a feathered white fiber ring on torn edges), lights every piece with the same soft sun and a long far lamp (a gentle light falloff from left to right), and renders on a transparent background with a shadow catcher. `bake.py` softens the shadows, derives the dark set, checks the plan's middle is flat enough to continue as a gradient, and writes `public/paper/` plus the paper variables in `src/styles.css`.

The pile (`pile.webp`, 1920 by 450, a 3x render drawn at 640 by 150 CSS px) is the 13 states the guide covers plus DC, cut in scissor snips from the crowd's papers (deep, green, tint and cream; the mustard stays with the crowd) and dropped in a heap that runs off the bottom of the frame. It sits on the bottom edge of the first page as wide as the page, drawn at its own size in the middle: a phone sees the heap run off both sides, and a screen 640 px or wider sees all of it end in bare desk. Each state is drawn in an Albers equal-area projection centered on itself and cut from its own outline; islands smaller than 2% of a state's main piece are left out (Long Island stays). DC is a small punched dot dropped on top.

The layout, in `render.py`:

- `PILE`: back to front, each piece's middle (x, y, in scene units from the frame's center; 1 unit is 100 CSS px), its size (the square root of its area: .60 to .96, DC .12), a turn in degrees (-31 to 35) and its paper. The places came from a scratch search (Oct 20; the first heap crowded the left of a phone and left desk under its right side), kept out of the repo: simulated annealing over each piece's place, size (within 8% of its earlier size) and turn, and the order the pieces fall in. It aimed for paper on every column of the frame's bottom edge, even cover across a phone's middle 390 px with as much paper left of center as right, no desk showing between pieces under the heap's top edge, each state showing at least 62% of itself, and nothing past the frame's top or sides. Kevin chose this layout from four candidates. The papers were then dealt so touching pieces mostly differ and each paper spreads across the width. DC is a small punched dot on top, set where the city sits on Maryland's southwest edge. The numbers are fixed in `PILE`, so a render is repeatable.
- `PILE_FRAME` 6.4 by 1.5 units. `PILE_STEP` .017: how far a sheet clears the one under it (its .006 thickness plus the most a .006 crumple and a .003 edge lift raise the one below).
- The drape: paper isn't stiff, so each piece lies on a height map of the pieces already down (`PILE_RES` 100 cells per unit, spread 7 cells past their edges and blurred by a Gaussian of 3.5 cells, so a sheet rides up over an edge and settles back to the desk without dipping into what's under it), then adds itself to the map.
- `bake.py` checks every piece for a baked black edge along the outline. In the pile, deep green paper in the shade between two sheets is dark too, so the check counts only dark pixels next to the desk.

If the guide adds a state, add a line to `PILE` where the heap has a gap, render and bake again. The band's size is `.pile` in `src/styles.css`: 145 px tall, with the render's bottom 5 px cut off (the bake's softening leaves the image's very edge a little see-through, and where two pieces meet at the bottom their lifted edges can leave a sliver of desk there), and the first page's bottom padding 163 px. The `<img>` is in `src/views/mast.ts`.

- Outlines: [Natural Earth](https://www.naturalearthdata.com/) 1:50m admin-1 states and provinces, the version with lakes cut out (so the Great Lakes and the Chesapeake read as water), `ne_50m_admin_1_states_provinces_lakes.geojson` from [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) at commit `ca96624a56bd078437bca8184e78163e5039ad19` (SHA-256 of the file `b92c3f709b691240f6320e5cd7fade78cedfa3b91ecff14cecd3de0616c764b9`).
- License: public domain. Natural Earth's terms: "All versions of Natural Earth raster + vector map data found on this website are in the public domain" (https://www.naturalearthdata.com/about/terms-of-use/). No credit is required; this line gives it anyway.
- The GeoJSON is about 2.4 MB and is not kept in this repo; the command above fetches it.

The two paper-grain tiles (`public/paper/stock.webp`, `stock-dark.webp`, 256 px, seamless) were made once for the mock-up and are not regenerated by these scripts; their source is the workbench's `prototypes/worn-green/assets/`.

How it is used in CSS:
- Everything but the pile is a plain background image. The plan notice is a torn top band and a torn bottom band with a sampled gradient between them, so it takes any height. Each section strip is one image scaled to its header's height, rendered at 3x and pressed flat (thin stock, no lifted edges, a softer sun), so its cut end stays clean on a phone. (An earlier version used `border-image`; Safari scaled its slices roughly and the cut ends showed stair steps on a 3x iPhone.)
- The cheat sheet's torn top is a band; its fill continues the render's light with a sampled gradient.
- Dark mode swaps to `public/paper/dark/` through CSS variables. The pile is an `<img>` (lazy, empty alt), so it swaps through `<picture>` and the `prefers-color-scheme` media query instead; its pale papers are dimmed a step more than the greens in the dark set so they don't glare.
- Print hides all of it.

The method, what failed on the way, and the design rules behind it (paper, one printed ink, pen) are written up in the workbench repo: `claude-plans/2026-10-19-paper-skin/METHOD.md` and the `real-materials` skill.

**The sheet's torn bottom** (`sheet-bot.webp`, light and dark, Oct 21) is `sheet.webp` flipped top to bottom, not a render of its own, so its light still meets the fill: `python3 -c "from PIL import Image; [Image.open(f'public/paper/{d}sheet.webp').transpose(Image.FLIP_TOP_BOTTOM).save(f'public/paper/{d}sheet-bot.webp', 'WEBP', quality=90, method=6) for d in ('', 'dark/')]"`. Rerun it after re-rendering the sheet.
