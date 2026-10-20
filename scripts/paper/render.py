"""Paper pieces for the voting guide, rendered with Blender's Cycles path tracer (Oct 19 2026).

    <venv>/bin/python scripts/paper/render.py OUT_DIR JOB[,JOB...] [SAMPLES]

Jobs: plan, strip-a, strip-b, strip-c, strip-d, sheet, crowd, states (envelope is kept as an example of a two-piece
prop). The states job reads its outlines from the GeoJSON file named by the STATES environment variable.
Each job writes OUT_DIR/<job>.png: the paper in its final color with its cast shadow, on a transparent
background (the ground is a Cycles shadow catcher), ready to lay on the page. Every piece is lit by the
same sun from the upper left, so they all sit on one desk.

Setup: python3 -m venv bl && bl/bin/pip install bpy scikit-image   (bpy 5.2 wheel, CPU rendering, no display)
"""
import sys, os, math
import numpy as np
import bpy, bmesh
from mathutils import Vector, kdtree
from mathutils.geometry import delaunay_2d_cdt

OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
JOBS = sys.argv[2].split(',')
SAMPLES = int(sys.argv[3]) if len(sys.argv) > 3 else 48
PX = float(os.environ.get('PX', 200))   # render pixels per scene unit; 200 = one unit is 100 CSS px on a 2x screen, 300 = 3x
SUN, LAMP, WORLD = float(os.environ.get('SUN', 1.04)), float(os.environ.get('LAMP', 18100)), float(os.environ.get('WORLD', .174))

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + .055) / 1.055) ** 2.4 if v > .04045 else v / 12.92 for v in c) + (1.0,)

# Worn green. Paper colors are the paper itself; ink colors live in the CSS.
PAPER = {
    'green': '#3E7064', 'deep': '#2E5A50', 'worn': '#4F806F', 'faded': '#7C9D8D', 'pale': '#A9C2B3',
    'mustard': '#D8A834', 'cream': '#E6DCC4', 'white': '#FAF8F2', 'core': '#F3EFE4',
}

def TONE(h, k):
    h = h.lstrip('#'); return '#%02X%02X%02X' % tuple(min(255, int(round(int(h[i:i + 2], 16) * k))) for i in (0, 2, 4))

def noise1d(n, beta, seed):
    r = np.random.default_rng(seed)
    F = np.fft.fft(r.standard_normal(n)); f = np.abs(np.fft.fftfreq(n)); f[0] = 1
    F = F / f ** beta; F[0] = 0
    o = np.real(np.fft.ifft(F)); return (o - o.mean()) / (o.std() + 1e-9)

# ---------------------------------------------------------------- outlines (counterclockwise, scene units)

def rect_outline(w, h, seed, torn=(), wobble=0.10, rag=0.014, tilt=0.0, per_unit=110):
    """A w x h rectangle centered on the origin. Sides named in `torn` are torn (low wobble plus a rag whose
    strength itself wanders); the others are scissor-cut: straight snips that change direction by a hair."""
    r = np.random.default_rng(seed)
    corners = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    names = ['bottom', 'right', 'top', 'left']
    pts, flags = [], []
    for i, name in enumerate(names):
        a = np.array(corners[i]); b = np.array(corners[(i + 1) % 4])
        L = np.linalg.norm(b - a); n = max(12, int(per_unit * L))
        t = np.linspace(0, 1, n, endpoint=False)
        p = a + (b - a) * t[:, None]
        d = (b - a) / L; nrm = np.array([d[1], -d[0]])          # outward for a ccw outline
        if name in torn:
            k = np.clip(np.minimum(t, 1 - t) * 6, 0, 1)
            amp = 0.4 + 0.6 * np.abs(noise1d(2 * n, 1.8, seed + 20 + i)[:n])
            off = wobble * noise1d(2 * n, 1.5, seed + i)[:n] + rag * amp * noise1d(2 * n, 0.85, seed + 10 + i)[:n]
            p = p + nrm * (off * k)[:, None]
            flags += [True] * n
        else:
            # scissor snips: piecewise straight, each snip 0.45 to 0.9 units, a tenth of a degree off the last
            off = np.zeros(n); s = 0.0; ang = r.normal(0, .0015); pos = 0.0; nxt = r.uniform(.45, .9)
            for j in range(n):
                tj = t[j] * L
                if tj > nxt: pos = s; ang = np.clip(ang + r.normal(0, .0025), -.006, .006); nxt += r.uniform(.45, .9); s += r.normal(0, .0012)
                s = pos + ang * (tj - (nxt - .7)); off[j] = s
            off += tilt * (t - .5) * L
            p = p + nrm * off[:, None]
            flags += [False] * n
        pts.append(p)
    return np.ascontiguousarray(np.concatenate(pts)), np.array(flags)

def _sd_ellipse(X, Y, cx, cy, rx, ry):
    return (np.sqrt(((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2) - 1.0) * min(rx, ry)

def _sd_capsule(X, Y, ax, ay, bx, by, r):
    px, py = X - ax, Y - ay; bxv, byv = bx - ax, by - ay
    h = np.clip((px * bxv + py * byv) / (bxv * bxv + byv * byv), 0, 1)
    return np.hypot(px - bxv * h, py - byv * h) - r

def _sd_rbox(X, Y, cx, cy, hx, hy, rad):
    qx = np.abs(X - cx) - hx + rad; qy = np.abs(Y - cy) - hy + rad
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rad

def _smin(a, b, k):
    h = np.clip(.5 + .5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)

def person_outline(seed, hw=0.44, hair='short', lean=0.0, sx=1.0, drop=0.0, tilt=0.0, profile=0):
    """One cut-paper person, head and shoulders, shoulder line at y = 0, torso running off the bottom.
    hw is the head width; drop tilts the shoulders (degrees), tilt the head (degrees); profile is -1 or 1
    for a person turned to face left or right. Built as a smooth signed-distance shape, traced, then
    re-cut in scissor snips."""
    from skimage import measure
    r = np.random.default_rng(seed)
    h = hw
    step = 0.004
    xs = np.arange(-1.9 * h, 1.9 * h, step); ys = np.arange(-3.6 * h, 2.4 * h, step)
    X, Y = np.meshgrid(xs, ys)
    def rot(X, Y, cx, cy, deg):
        a = math.radians(deg); c, s_ = math.cos(a), math.sin(a)
        return cx + (X - cx) * c + (Y - cy) * s_, cy - (X - cx) * s_ + (Y - cy) * c
    if profile: sx = min(sx, .78)
    Xb, Yb = rot(X, Y, 0, -.1 * h, drop)
    body = _sd_rbox(Xb, Yb, 0, -1.75 * h, 1.2 * h * sx, 1.75 * h, .62 * h)
    dx = lean * h + profile * .1 * h
    hy = 1.02 * h
    Xh, Yh = rot(X, Y, dx * .55, .45 * h, tilt)
    neck = _sd_capsule(Xh, Yh, 0, -.2 * h, dx * .55 + profile * .06 * h, .45 * h, .23 * h)
    head = _sd_ellipse(Xh, Yh, dx, hy, .49 * h, .6 * h)
    if profile:
        head = _smin(head, _sd_ellipse(Xh, Yh, dx + profile * .5 * h, hy - .04 * h, .13 * h, .09 * h), .05 * h)     # nose
        head = _smin(head, _sd_ellipse(Xh, Yh, dx + profile * .3 * h, hy - .42 * h, .16 * h, .12 * h), .06 * h)    # chin
    if hair == 'bun':
        bx = dx - profile * .38 * h if profile else dx + .04 * h
        head = _smin(head, _sd_ellipse(Xh, Yh, bx, hy + (.42 if profile else .64) * h, .24 * h, .21 * h), .07 * h)
    elif hair == 'pony':
        # a low ponytail lying on the shoulder
        side = 1 if r.random() < .5 else -1
        head = _smin(head, _sd_capsule(Xh, Yh, dx + side * .3 * h, hy - .35 * h, dx + side * .52 * h, hy - 1.05 * h, .15 * h), .14 * h)
    elif hair == 'long':
        head = _smin(head, _sd_rbox(Xh, Yh, dx, hy - .55 * h, .6 * h, .78 * h, .38 * h), .12 * h)
    elif hair == 'bob':
        head = _smin(head, _sd_rbox(Xh, Yh, dx, hy - .12 * h, .58 * h, .56 * h, .44 * h), .1 * h)
    elif hair == 'curly':
        th = np.arctan2(Yh - hy, Xh - dx)
        head = _sd_ellipse(Xh, Yh, dx, hy + .03 * h, .62 * h, .66 * h) + .018 * h * np.sin(9 * th + r.uniform(0, 6.28))
    elif hair == 'cap':
        head = _smin(head, _sd_rbox(Xh, Yh, dx + (profile or 1) * .14 * h, hy + .26 * h, .62 * h, .1 * h, .08 * h), .03 * h)
    s = _smin(_smin(body, neck, .32 * h), head, .06 * h)
    cs = measure.find_contours(s, 0.0)
    c = max(cs, key=len)
    P = np.stack([xs[0] + c[:, 1] * step, ys[0] + c[:, 0] * step], 1)
    return scissor_recut(P, r)

def scissor_recut(P, r, snip=(.035, .07), jitter=.0015):
    """Re-cut a traced outline in scissor snips: straight segments `snip` units long, a hair of jitter at each
    joint, then densified so the mesh and the edge lift have points to hold. Returns a counterclockwise outline."""
    if np.sum(P[:-1, 0] * P[1:, 1] - P[1:, 0] * P[:-1, 1]) < 0: P = P[::-1]
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    total = seg[-1]; marks = [0.0]
    while marks[-1] < total: marks.append(marks[-1] + r.uniform(*snip))
    marks = np.array(marks[:-1])
    V = np.stack([np.interp(marks, seg, P[:, 0]), np.interp(marks, seg, P[:, 1])], 1)
    V += r.normal(0, jitter, V.shape)
    dense = []
    for i in range(len(V)):
        a, b = V[i], V[(i + 1) % len(V)]; m = max(2, int(np.linalg.norm(b - a) / .008))
        for j in range(m): dense.append(a + (b - a) * j / m)
    D = np.ascontiguousarray(np.array(dense))
    return D, np.zeros(len(D), bool)

# ---------------------------------------------------------------- geometry

def _inside(G, P):
    x, y = G[:, 0], G[:, 1]; ins = np.zeros(len(G), bool); j = len(P) - 1
    for i in range(len(P)):
        xi, yi = P[i]; xj, yj = P[j]
        ins ^= ((yi > y) != (yj > y)) & (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi); j = i
    return ins

def tessellate(P, spacing):
    lo, hi = P.min(0), P.max(0)
    gx = np.arange(lo[0] + spacing, hi[0], spacing); gy = np.arange(lo[1] + spacing, hi[1], spacing)
    G = np.array([(x + (.5 * spacing if j % 2 else 0), y) for j, y in enumerate(gy) for x in gx], float)
    keep = _inside(G, P)
    P32, G32 = P.astype(np.float32), G.astype(np.float32); dmin = np.empty(len(G), np.float32)
    for a in range(0, len(G), 1500):
        dmin[a:a + 1500] = np.sqrt(((G32[a:a + 1500, None] - P32[None]) ** 2).sum(-1)).min(1)
    keep &= dmin > spacing * .55
    verts = [Vector((float(x), float(y))) for x, y in P] + [Vector((float(x), float(y))) for x, y in G[keep]]
    out = delaunay_2d_cdt(verts, [], [list(range(len(P)))], 1, 1e-7)
    return out[0], out[2]

def paper_mat(name, hexcolor, rough=.82, sss=.25, bump=.18):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); p = nt.nodes.new('ShaderNodeBsdfPrincipled')
    p.inputs['Base Color'].default_value = lin(hexcolor)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Specular IOR Level'].default_value = .2
    p.inputs['Subsurface Weight'].default_value = sss
    p.inputs['Subsurface Radius'].default_value = (.02, .018, .015)
    p.inputs['Subsurface Scale'].default_value = .05
    p.inputs['Sheen Weight'].default_value = .1
    if bump > 0:
        tx = nt.nodes.new('ShaderNodeTexNoise'); tx.inputs['Scale'].default_value = 520.0; tx.inputs['Detail'].default_value = 4.0
        bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = .002
        nt.links.new(tx.outputs['Fac'], bp.inputs['Height']); nt.links.new(bp.outputs['Normal'], p.inputs['Normal'])
    nt.links.new(p.outputs[0], out.inputs['Surface'])
    return m

def fringe_mat(name, hexcolor):
    """The exposed core of a torn edge: white fibers that feather out (u runs 0 at the face to 1 outside)."""
    m = paper_mat(name, hexcolor, rough=.92, sss=.5, bump=.4); nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'); out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    sn = nt.nodes.new('ShaderNodeTexNoise'); sn.inputs['Scale'].default_value = 150.0; sn.inputs['Detail'].default_value = 9.0
    sn.inputs['Roughness'].default_value = .85; sn.inputs['Distortion'].default_value = 1.0
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'u'; sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(uv.outputs['UV'], sep.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = .12; mr.inputs['To Max'].default_value = .62
    nt.links.new(sep.outputs['X'], mr.inputs['Value'])
    gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'
    nt.links.new(sn.outputs['Fac'], gt.inputs[0]); nt.links.new(mr.outputs['Result'], gt.inputs[1])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mx = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(gt.outputs[0], mx.inputs['Fac']); nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(p.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs['Surface'])
    return m

def _weights(me, pts, fade):
    """Per-vertex weight 1 at the outline points given, falling to 0 at distance `fade`."""
    kd = kdtree.KDTree(len(pts))
    for i, (x, y) in enumerate(pts): kd.insert((float(x), float(y), 0.0), i)
    kd.balance()
    return [max(0.0, 1.0 - kd.find((v.co.x, v.co.y, 0.0))[2] / fade) for v in me.vertices]

def piece(name, P, torn, face, rim, fringe=None, z=0.0, thick=.009, crumple=(.02, 1.6), crumple_fade=None,
          lift=.006, lift_fade=.18, fringe_w=.035, spacing=.035, seed=0):
    vc, faces = tessellate(P, spacing)
    bm = bmesh.new(); bv = [bm.verts.new((v.x, v.y, 0.0)) for v in vc]
    for f in faces:
        try: bm.faces.new([bv[i] for i in f])
        except ValueError: pass
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob); ob.location.z = z + thick + .0006
    me.materials.append(face); me.materials.append(rim)
    sub = ob.modifiers.new('sub', 'SUBSURF'); sub.subdivision_type = 'SIMPLE'; sub.levels = sub.render_levels = 1
    # crumple: everywhere, or only near the torn edges (so a flat middle can meet a CSS fill)
    tex = bpy.data.textures.new(name + '-c', 'CLOUDS'); tex.noise_scale = crumple[1]; tex.noise_depth = 3
    dc = ob.modifiers.new('crumple', 'DISPLACE'); dc.texture = tex; dc.strength = crumple[0]; dc.mid_level = 0.0
    if crumple_fade is not None:
        g = ob.vertex_groups.new(name='near_tear'); w = _weights(me, P[torn] if torn.any() else P, crumple_fade)
        for i, wi in enumerate(w): g.add([i], wi, 'REPLACE')
        dc.vertex_group = 'near_tear'
    # edges lift a hair off the page, so the shadow has a soft lip
    g2 = ob.vertex_groups.new(name='edge'); w2 = _weights(me, P, lift_fade)
    for i, wi in enumerate(w2): g2.add([i], wi * wi, 'REPLACE')
    dl = ob.modifiers.new('lift', 'DISPLACE'); dl.strength = lift; dl.mid_level = 0.0; dl.vertex_group = 'edge'
    so = ob.modifiers.new('solid', 'SOLIDIFY'); so.thickness = thick; so.offset = -1; so.use_rim = True; so.material_offset_rim = 1
    sm = ob.modifiers.new('smooth', 'SMOOTH'); sm.factor = .5; sm.iterations = 2
    for p in me.polygons: p.use_smooth = True
    if fringe is not None and torn.any():
        n = len(P); c = P.mean(0); N = np.zeros_like(P)
        for i in range(n):
            t = P[(i + 1) % n] - P[(i - 1) % n]; v = np.array([t[1], -t[0]]); N[i] = v / (np.linalg.norm(v) + 1e-9)
        if np.mean(np.sum((P - c) * N, 1)) < 0: N = -N
        wid = fringe_w * np.clip(.7 + .45 * noise1d(n, 1.3, seed + 77), .15, 1.3) * torn
        Q = P + N * wid[:, None]
        bm = bmesh.new(); uvl = bm.loops.layers.uv.new('u')
        vi = [bm.verts.new((float(x), float(y), 0.0)) for x, y in P]; vo = [bm.verts.new((float(x), float(y), 0.0)) for x, y in Q]
        for i in range(n):
            if not (torn[i] and torn[(i + 1) % n]): continue
            try: f = bm.faces.new((vi[i], vi[(i + 1) % n], vo[(i + 1) % n], vo[i]))
            except ValueError: continue
            for lp in f.loops: lp[uvl].uv = (1.0 if lp.vert in (vo[i], vo[(i + 1) % n]) else 0.0, 0.0)
        m2 = bpy.data.meshes.new(name + '-fringe'); bm.to_mesh(m2); bm.free()
        fr = bpy.data.objects.new(name + '-fringe', m2); bpy.context.collection.objects.link(fr)
        fr.location.z = z + thick * .35 + .0006; m2.materials.append(fringe)
        d = fr.modifiers.new('crumple', 'DISPLACE'); d.texture = tex; d.strength = crumple[0]; d.mid_level = 0.0
        fr.parent = ob; fr.visible_shadow = False
    return ob

# ---------------------------------------------------------------- scene

def scene(fw, fh, catcher=True):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True; sc.cycles.use_adaptive_sampling = True
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'; sc.view_settings.exposure = float(os.environ.get('EXPOSURE', -.245))
    sc.render.resolution_x = int(round(fw * PX)); sc.render.resolution_y = int(round(fh * PX)); sc.render.resolution_percentage = 100
    cd = bpy.data.cameras.new('cam'); cd.type = 'ORTHO'; cd.ortho_scale = max(fw, fh)
    cam = bpy.data.objects.new('cam', cd); bpy.context.collection.objects.link(cam); cam.location = (0, 0, 10); sc.camera = cam
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = SUN; sun.angle = math.radians(float(os.environ.get('SUN_ANGLE', 20)))
    so = bpy.data.objects.new('sun', sun); bpy.context.collection.objects.link(so)
    d = Vector((-.45, .55, .8)).normalized(); so.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    # a long strip light far to the left: light falls off across the page, not down it
    lamp = bpy.data.lights.new('lamp', 'AREA'); lamp.shape = 'RECTANGLE'; lamp.size = 3.0; lamp.size_y = 60.0; lamp.energy = LAMP
    lo = bpy.data.objects.new('lamp', lamp); bpy.context.collection.objects.link(lo); lo.location = (-24.0, 0.0, 12.0)
    lo.rotation_euler = (-lo.location).to_track_quat('-Z', 'Y').to_euler()
    w = bpy.data.worlds.new('w'); w.use_nodes = True; sc.world = w
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (1, .98, .95, 1); bg.inputs['Strength'].default_value = WORLD
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, -.0004)); g = bpy.context.active_object
    g.scale = (fw * 4, fh * 4, 1); g.is_shadow_catcher = True
    return sc

def render(sc, name):
    sc.render.filepath = os.path.join(OUT, name + '.png'); bpy.ops.render.render(write_still=True)
    print('wrote', sc.render.filepath, flush=True)

# ---------------------------------------------------------------- jobs

def job_plan():
    """The next-step notice: green paper torn top and bottom, wider than any phone, flat in the middle."""
    fw, fh = 6.4, 3.6
    sc = scene(fw, fh)
    P, torn = rect_outline(6.24, 2.7, 11, torn=('top', 'bottom'), wobble=.085, rag=.02)
    piece('plan', P, torn, paper_mat('g', PAPER['green']), paper_mat('gr', PAPER['core'], sss=.5), fringe_mat('gf', PAPER['core']),
          crumple=(.03, 1.4), crumple_fade=.5, fringe_w=.05, seed=11)
    render(sc, 'plan')

def job_strip(seed, name, tilt_deg=-.3, k=1.0):
    """A section label: a strip of green paper that enters from the left edge of the page and ends in a visible
    scissor cut a few px in from the right edge, laid on with a hair of tilt."""
    fw, fh = 6.4, 1.0
    sc = scene(fw, fh)
    P, torn = rect_outline(6.2, .6, seed, torn=())
    left = P[:, 0] < P[:, 0].min() + .02
    right = P[:, 0] > P[:, 0].max() - .02
    P[left, 0] += P[left, 1] * .03                      # the ends are cut at a slight slant, not square; this end
    P[right, 0] -= P[right, 1] * .05                    # becomes the visible one after the mirror below, so it is
                                                        # the gentler cut (a steep slant steps on phone screens)
    P[:, 0] += -3.12 + 3.1                              # left end sits about 8 CSS px in from the page edge
    P[:, 0] = -P[:, 0]; P = P[::-1].copy(); torn = torn[::-1]   # mirrored: enters from the left, cut end on the right
    th = math.radians(tilt_deg); R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    P = np.ascontiguousarray(P @ R.T)
    # Pressed flat on the page (Kevin, Oct 20: "paper pressed against the paper"): thin stock, no lifted edges,
    # barely any crumple, so the shadow is a faint contact line instead of a cast shadow.
    piece(name, P, torn, paper_mat('g', TONE(PAPER['green'], k)), paper_mat('gr', TONE(PAPER['worn'], k), sss=.3), thick=.004, crumple=(.004, 1.3), crumple_fade=.12, lift=0, lift_fade=.12, spacing=.03, seed=seed)
    render(sc, name)

def job_sheet():
    """The cheat sheet's top: white paper torn off a pad, wider than any phone (the page crops its sides)."""
    fw, fh = 6.4, 1.0
    sc = scene(fw, fh)
    P, torn = rect_outline(6.24, 2.0, 5, torn=('top',), wobble=.035, rag=.013)
    P[:, 1] -= 1.0 - .28        # the torn top sits .22 below the frame top; the rest runs off the bottom
    piece('sheet', P, torn, paper_mat('w', PAPER['white'], bump=.08), paper_mat('wr', PAPER['core']), fringe_mat('wf', PAPER['core']),
          crumple=(.016, 1.4), crumple_fade=.3, fringe_w=.035, seed=5)
    render(sc, 'sheet')

CROWD = [  # x, row, hair, paper, extra shape arguments
    (-2.05, 0, 'short', 'tint', dict(drop=3)), (-0.72, 0, 'bun', 'deep', dict(tilt=-6)), (0.62, 0, 'curly', 'green', {}), (1.95, 0, 'long', 'deep', dict(drop=-4)),
    (-1.42, 1, 'bob', 'green', dict(tilt=5)), (-0.08, 1, 'cap', 'cream', dict(profile=1)), (1.30, 1, 'pony', 'deep', dict(drop=4)), (2.35, 1, 'short', 'tint', dict(profile=-1)),
    (-2.30, 2, 'long', 'deep', dict(drop=-5)), (-0.98, 2, 'short', 'mustard', {}), (0.36, 2, 'bun', 'green', dict(s=.72, tilt=7)), (1.62, 2, 'curly', 'tint', dict(drop=4)),
]
CROWD_PAPER = {'deep': '#2E5A50', 'green': '#416E62', 'tint': '#7F9D91', 'cream': '#EFE9DA', 'mustard': '#D8A834'}
ROWS = {0: (.62, .62, 0.000), 1: (.78, .28, .006), 2: (1.0, -.10, .012)}   # scale, shoulder-line y, z

def job_crowd():
    """A crowd at the bottom of the page: a dozen people cut from two greens, a green tint, the page's own
    cream and one mustard (you). Every figure is whole, with bare desk on both sides."""
    fw, fh = 6.0, 2.4
    sc = scene(fw, fh)
    rim = paper_mat('rim', PAPER['core'], sss=.4)
    for i, (x, row, hair, col, kw) in enumerate(CROWD):
        s, ys, z = ROWS[row]
        kw = dict(kw); s2 = kw.pop('s', 1.0)
        P, torn = person_outline(100 + i, hw=.44 * s * s2, hair=hair, **kw)
        P = P + np.array([x, ys - (1 - s2) * .5 - fh / 2 + .55])
        piece('p%d' % i, np.ascontiguousarray(P), torn, paper_mat('f%d' % i, CROWD_PAPER[col]), rim, z=z, thick=.006,
              crumple=(.008, 1.8), lift=.003, lift_fade=.08, spacing=.025, seed=100 + i)
    render(sc, 'crowd')

# ---------------------------------------------------------------- the covered states

STATES_SRC = os.environ.get('STATES', '')   # Natural Earth admin-1 states with lakes cut out (public domain); see README
_GEO = {}

def _area(P):
    return .5 * float(np.sum(P[:-1, 0] * P[1:, 1] - P[1:, 0] * P[:-1, 1]))

def _albers(lon, lat, lon0, lat0, p1=29.5, p2=45.5):
    """Albers equal-area conic on a sphere, the usual projection for maps of the US, centered on one state so
    the state stands upright the way it is drawn on its own."""
    p1, p2, l0 = math.radians(p1), math.radians(p2), math.radians(lat0)
    n = (math.sin(p1) + math.sin(p2)) / 2; C = math.cos(p1) ** 2 + 2 * n * math.sin(p1)
    rho0 = math.sqrt(C - 2 * n * math.sin(l0)) / n
    th = n * np.radians(lon - lon0); rho = np.sqrt(C - 2 * n * np.sin(np.radians(lat))) / n
    return rho * np.sin(th), rho0 - rho * np.cos(th)

def state_rings(code, keep=.02):
    """One state's outer rings, projected, largest first. Islands under `keep` of the largest piece are left
    out (Long Island stays; the Channel Islands, the Keys and Padre Island go)."""
    if not _GEO:
        import json
        assert STATES_SRC, 'set STATES to the Natural Earth admin-1 GeoJSON (see scripts/paper/README.md)'
        for f in json.load(open(STATES_SRC, encoding='utf-8'))['features']:
            if f['properties'].get('adm0_a3') == 'USA': _GEO[f['properties']['postal']] = f['geometry']
    g = _GEO[code]; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    rings = [np.array(p[0], float) for p in polys]
    lo = np.concatenate(rings).min(0); hi = np.concatenate(rings).max(0); lon0, lat0 = (lo + hi) / 2
    out = sorted((np.stack(_albers(R[:, 0], R[:, 1], lon0, lat0), 1) for R in rings), key=lambda P: -abs(_area(P)))
    return [P for P in out if abs(_area(P)) >= keep * abs(_area(out[0]))]

# A loose row, west to east, the way the crowd stands: x, y of the state's middle, a turn in degrees, paper.
# DC is a small punched dot on Maryland's edge, about where it sits on a map.
STATE_ROW = [
    ('WA', -2.67, .34, -4, 'deep'), ('OR', -2.27, -.36, 3, 'tint'), ('CA', -1.81, .22, -2, 'green'),
    ('CO', -1.37, -.38, 4, 'cream'), ('TX', -0.91, .30, -3, 'deep'), ('MO', -0.41, -.34, 4, 'tint'),
    ('IL', 0.01, .30, -5, 'green'), ('AL', 0.41, -.34, 3, 'deep'), ('GA', 0.85, .32, -2, 'tint'),
    ('FL', 1.33, -.32, 4, 'green'), ('PA', 1.75, .40, -3, 'cream'), ('MD', 2.23, -.30, 5, 'deep'),
    ('DC', 2.25, -.40, 0, 'cream'), ('NY', 2.53, .40, -4, 'tint'),
]
STATE_SIZE, STATE_EVEN = .52, .12   # the square root of a state's area is about STATE_SIZE * (its area over the median's) ** STATE_EVEN

def states_layout(seed=300):
    """Each covered state as scissor-cut outlines in place: [(code, [outline, ...], paper)], back to front."""
    sizes = {c: sum(abs(_area(P)) for P in state_rings(c)) for c, *_ in STATE_ROW if c != 'DC'}
    med = float(np.median(list(sizes.values())))
    out = []
    for i, (code, x, y, turn, col) in enumerate(STATE_ROW):
        r = np.random.default_rng(seed + i)
        if code == 'DC':
            t = np.linspace(0, 2 * math.pi, 90, endpoint=False); rings = [np.stack([.065 * np.cos(t), .065 * np.sin(t)], 1)]
            k, snip = 1.0, (.012, .02)
        else:
            rings = state_rings(code); allp = np.concatenate(rings); mid = (allp.min(0) + allp.max(0)) / 2
            rings = [P - mid for P in rings]
            k = STATE_SIZE * (sizes[code] / med) ** STATE_EVEN / math.sqrt(sizes[code]); snip = (.022, .045)
        th = math.radians(turn); R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        cuts = [scissor_recut(np.ascontiguousarray(P * k @ R.T + np.array([x, y])), r, snip=snip, jitter=.0008)[0] for P in rings]
        out.append((code, cuts, col))
    return out

def job_states():
    """A footer for the first page: the outlines of the states the guide covers, cut from the crowd's papers and
    laid in a loose row, west to east."""
    fw, fh = 6.4, 1.7                   # room on the right for the shadows, so none is cut by the frame
    sc = scene(fw, fh)
    rim = paper_mat('rim', PAPER['core'], sss=.4)
    for i, (code, cuts, col) in enumerate(states_layout()):
        face = paper_mat('s%d' % i, CROWD_PAPER[col])
        for j, P in enumerate(cuts):
            piece('%s%d' % (code, j), P, np.zeros(len(P), bool), face, rim, z=.004 * i, thick=.006,
                  crumple=(.006, 1.8), lift=.003, lift_fade=.06, spacing=.02, seed=300 + i)
    render(sc, 'states')

def job_envelope():
    """A plain white envelope, flap hinged at the top edge and lifting a little."""
    fw, fh = 2.2, 1.7
    sc = scene(fw, fh)
    w = paper_mat('w', PAPER['white'], bump=.06); rim = paper_mat('r', PAPER['core'])
    B, tb = rect_outline(1.7, 1.12, 31, torn=())
    piece('body', B, tb, w, rim, thick=.007, crumple=(.008, 1.0), spacing=.03)
    n = 70; fl = []
    for a, b in (((-.85, 0.0), (0.0, -.66)), ((0.0, -.66), (.85, 0.0)), ((.85, 0.0), (-.85, 0.0))):
        for i in range(n): t = i / n; fl.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    F = np.ascontiguousarray(np.array(fl))
    fob = piece('flap', F, np.zeros(len(F), bool), w, rim, thick=.007, crumple=(.006, 1.0), lift=.0, spacing=.03)
    fob.location = (0, .56, .012); fob.rotation_euler = (math.radians(-5), 0, 0)
    render(sc, 'envelope')

TABLE = {'plan': job_plan, 'strip-a': lambda: job_strip(23, 'strip-a', -.3, .97), 'strip-b': lambda: job_strip(51, 'strip-b', .25, 1.04),
         'strip-c': lambda: job_strip(67, 'strip-c', -.15, 1.0), 'strip-d': lambda: job_strip(83, 'strip-d', .3, .99),
         'sheet': job_sheet, 'crowd': job_crowd, 'states': job_states, 'envelope': job_envelope}
for j in [j for j in JOBS if j]:
    print('job', j, flush=True); TABLE[j]()
