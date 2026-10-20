"""IFC geometry -> triangles per panel.

Usage: python geom.py MODEL.ifc ELEMS.json OUT.pkl
Reads records on demand through ifcindex (low memory).
"""
import os, pickle, re, json, math, collections, sys
from functools import lru_cache
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ifcindex import IfcFile

raw = None  # IfcFile, set in main
E = {}

def split(a):
    out, depth, cur, q = [], 0, [], False
    i, n = 0, len(a)
    while i < n:
        c = a[i]
        if q:
            cur.append(c)
            if c == "'":
                if i + 1 < n and a[i+1] == "'": cur.append("'"); i += 1
                else: q = False
        elif c == "'": q = True; cur.append(c)
        elif c == '(': depth += 1; cur.append(c)
        elif c == ')': depth -= 1; cur.append(c)
        elif c == ',' and depth == 0: out.append(''.join(cur).strip()); cur = []
        else: cur.append(c)
        i += 1
    out.append(''.join(cur).strip()); return out

@lru_cache(maxsize=200000)
def args(i):
    return split(raw[i][1])
def typ(i): return raw[i][0]
def ref(s):
    s = s.strip()
    return int(s[1:]) if s.startswith('#') else None
def reflist(s): return [int(x) for x in re.findall(r'#(\d+)', s)]
def nums(s): return [float(x) for x in re.findall(r'[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?', s)]

_pt = {}
def point(i):
    if len(_pt) > 400000: _pt.clear()
    if i not in _pt:
        v = nums(args(i)[0]);
        while len(v) < 3: v.append(0.0)
        _pt[i] = np.array(v[:3])
    return _pt[i]
def direction(i):
    v = nums(args(i)[0])
    while len(v) < 3: v.append(0.0)
    v = np.array(v[:3]); n = np.linalg.norm(v)
    return v / n if n else v

def axis2p3d(i):
    """IfcAxis2Placement3D / 2D -> 4x4"""
    a = args(i); t = typ(i)
    loc = point(ref(a[0]))
    if t == 'IFCAXIS2PLACEMENT2D':
        x = direction(ref(a[1])) if ref(a[1]) else np.array([1., 0, 0])
        z = np.array([0, 0, 1.])
    else:
        z = direction(ref(a[1])) if len(a) > 1 and ref(a[1]) else np.array([0, 0, 1.])
        x = direction(ref(a[2])) if len(a) > 2 and ref(a[2]) else np.array([1., 0, 0])
    x = x - np.dot(x, z) * z
    nx = np.linalg.norm(x)
    if nx < 1e-9:
        x = np.array([1., 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1., 0]); x = x - np.dot(x, z) * z
        nx = np.linalg.norm(x)
    x /= nx; y = np.cross(z, x)
    M = np.eye(4); M[:3, 0] = x; M[:3, 1] = y; M[:3, 2] = z; M[:3, 3] = loc
    return M

_plc = {}
def placement(i):
    if i is None: return np.eye(4)
    if i in _plc: return _plc[i]
    a = args(i)
    parent = placement(ref(a[0])) if ref(a[0]) else np.eye(4)
    M = parent @ axis2p3d(ref(a[1]))
    _plc[i] = M; return M

def cto(i):
    """IfcCartesianTransformationOperator3D(nonuniform)"""
    a = args(i); t = typ(i)
    ax1 = direction(ref(a[0])) if ref(a[0]) else np.array([1., 0, 0])
    ax2 = direction(ref(a[1])) if ref(a[1]) else np.array([0, 1., 0])
    org = point(ref(a[2]))
    sc = nums(a[3])[0] if a[3] not in ('$', '*') else 1.0
    ax3 = direction(ref(a[4])) if len(a) > 4 and ref(a[4]) else np.cross(ax1, ax2)
    sx = sy = sz = sc
    if t == 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM':
        sy = nums(a[5])[0] if len(a) > 5 and a[5] not in ('$', '*') else sc
        sz = nums(a[6])[0] if len(a) > 6 and a[6] not in ('$', '*') else sc
    M = np.eye(4); M[:3, 0] = ax1 * sx; M[:3, 1] = ax2 * sy; M[:3, 2] = ax3 * sz; M[:3, 3] = org
    return M

# ---------- 2D curves ----------
def curve_pts(i, n_arc=12):
    t = typ(i); a = args(i)
    if t == 'IFCPOLYLINE':
        return [point(p)[:2] for p in reflist(a[0])]
    if t == 'IFCCOMPOSITECURVE':
        out = []
        for seg in reflist(a[0]):
            sa = args(seg)
            same = sa[1].strip() == '.T.'
            pts = curve_pts(ref(sa[2]), n_arc)
            if not same: pts = pts[::-1]
            if out and pts and np.allclose(out[-1], pts[0], atol=1e-6): pts = pts[1:]
            out += pts
        return out
    if t == 'IFCTRIMMEDCURVE':
        basis = ref(a[0]); bt = typ(basis)
        sense = a[3].strip() == '.T.'
        def trim(s):
            pr = re.search(r'IFCPARAMETERVALUE\(([^)]*)\)', s)
            cp = reflist(s)
            return ('p', float(pr.group(1))) if pr else ('c', point(cp[0])[:2]) if cp else None
        t1, t2 = trim(a[1]), trim(a[2])
        if bt == 'IFCPOLYLINE' or bt == 'IFCLINE':
            p1 = t1[1] if t1[0] == 'c' else None; p2 = t2[1] if t2[0] == 'c' else None
            if p1 is not None and p2 is not None: return [p1, p2]
            return curve_pts(basis) if bt == 'IFCPOLYLINE' else []
        if bt in ('IFCCIRCLE', 'IFCELLIPSE'):
            ba = args(basis)
            M = axis2p3d(ref(ba[0]))
            r1 = nums(ba[1])[0]; r2 = nums(ba[2])[0] if bt == 'IFCELLIPSE' else r1
            c = M[:2, 3]; xa = M[:2, 0]; ya = M[:2, 1]
            def ang(tr):
                if tr[0] == 'p': return math.radians(tr[1]) if abs(tr[1]) > 2 * math.pi + 1e-3 else tr[1]
                d = tr[1] - c; return math.atan2(np.dot(d, ya) / r2, np.dot(d, xa) / r1)
            # parameter values in IFC plane angle units: assume degrees if > 2pi
            a1, a2 = ang(t1), ang(t2)
            if sense:
                while a2 <= a1: a2 += 2 * math.pi
            else:
                while a2 >= a1: a2 -= 2 * math.pi
            k = max(2, int(abs(a2 - a1) / (2 * math.pi) * 36) + 1)
            return [c + xa * r1 * math.cos(a1 + (a2 - a1) * j / k) + ya * r2 * math.sin(a1 + (a2 - a1) * j / k) for j in range(k + 1)]
    if t == 'IFCCIRCLE':
        ba = a; M = axis2p3d(ref(ba[0])); r = nums(ba[1])[0]
        c = M[:2, 3]; xa = M[:2, 0]; ya = M[:2, 1]
        return [c + xa * r * math.cos(2 * math.pi * j / 24) + ya * r * math.sin(2 * math.pi * j / 24) for j in range(24)]
    raise ValueError('curve ' + t)

def profile_pts(i):
    t = typ(i); a = args(i)
    if t in ('IFCARBITRARYCLOSEDPROFILEDEF', 'IFCARBITRARYPROFILEDEFWITHVOIDS'):
        pts = curve_pts(ref(a[2]))
        if len(pts) > 1 and np.allclose(pts[0], pts[-1], atol=1e-6): pts = pts[:-1]
        return pts
    if t == 'IFCRECTANGLEPROFILEDEF':
        M = axis2p3d(ref(a[2])) if ref(a[2]) else np.eye(4)
        x, y = nums(a[3])[0] / 2, nums(a[4])[0] / 2
        return [(M @ np.array([px, py, 0, 1]))[:2] for px, py in [(-x, -y), (x, -y), (x, y), (-x, y)]]
    if t == 'IFCCIRCLEPROFILEDEF':
        M = axis2p3d(ref(a[2])) if ref(a[2]) else np.eye(4); r = nums(a[3])[0]
        return [(M @ np.array([r * math.cos(2 * math.pi * j / 24), r * math.sin(2 * math.pi * j / 24), 0, 1]))[:2] for j in range(24)]
    raise ValueError('profile ' + t)

def earcut(pts):
    """simple ear clipping on 2D polygon; returns index triangles"""
    n = len(pts)
    if n < 3: return []
    P = np.array(pts)
    area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    idx = list(range(n)) if area > 0 else list(range(n))[::-1]
    tris = []
    def cross(o, a, b): return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    guard = 0
    while len(idx) > 3 and guard < 5 * n * n:
        guard += 1
        m = len(idx); found = False
        for k in range(m):
            i0, i1, i2 = idx[(k-1) % m], idx[k], idx[(k+1) % m]
            a, b, c = P[i0], P[i1], P[i2]
            if cross(a, b, c) <= 1e-12: continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2): continue
                p = P[j]
                if cross(a, b, p) >= -1e-12 and cross(b, c, p) >= -1e-12 and cross(c, a, p) >= -1e-12:
                    ok = False; break
            if ok:
                tris.append((i0, i1, i2)); idx.pop(k); found = True; break
        if not found:  # degenerate: fan the rest
            for k in range(1, len(idx) - 1): tris.append((idx[0], idx[k], idx[k+1]))
            return tris
    if len(idx) == 3: tris.append(tuple(idx))
    return tris

def extrude(i):
    a = args(i)
    pts = profile_pts(ref(a[0]))
    M = axis2p3d(ref(a[1])) if ref(a[1]) else np.eye(4)
    d = direction(ref(a[2])); depth = nums(a[3])[0]
    n = len(pts)
    if n < 3: return []
    base = [np.array([p[0], p[1], 0.0]) for p in pts]
    top = [b + d * depth for b in base]
    tris = []
    for (i0, i1, i2) in earcut(pts):
        tris.append((base[i0], base[i2], base[i1]))
        tris.append((top[i0], top[i1], top[i2]))
    for k in range(n):
        b0, b1, t0, t1 = base[k], base[(k+1) % n], top[k], top[(k+1) % n]
        tris.append((b0, b1, t1)); tris.append((b0, t1, t0))
    return [tuple((M @ np.append(v, 1))[:3] for v in t) for t in tris]

def face_tris(face):
    out = []
    bounds = reflist(args(face)[0])
    for b in bounds:
        if typ(b) != 'IFCFACEOUTERBOUND' and len(bounds) > 1: continue
        loop = ref(args(b)[0]); pts = [point(p) for p in reflist(args(loop)[0])]
        if args(b)[1].strip() == '.F.': pts = pts[::-1]
        if len(pts) == 3: out.append(tuple(pts))
        elif len(pts) > 3:
            # project to plane for ear clipping
            P = np.array(pts); c = P.mean(0)
            nrm = np.zeros(3)
            for k in range(len(P)): nrm += np.cross(P[k] - c, P[(k+1) % len(P)] - c)
            if np.linalg.norm(nrm) < 1e-12: continue
            nrm /= np.linalg.norm(nrm)
            u = P[1] - P[0]; u -= np.dot(u, nrm) * nrm; u /= (np.linalg.norm(u) or 1); v = np.cross(nrm, u)
            p2 = [(np.dot(p - c, u), np.dot(p - c, v)) for p in P]
            for (i0, i1, i2) in earcut(p2):
                tri = (pts[i0], pts[i1], pts[i2])
                if np.dot(np.cross(tri[1]-tri[0], tri[2]-tri[0]), nrm) < 0: tri = (tri[0], tri[2], tri[1])
                out.append(tri)
        break
    return out

def item_tris(i, depth=0):
    t = typ(i); a = args(i)
    if t == 'IFCEXTRUDEDAREASOLID': return extrude(i)
    if t == 'IFCFACETEDBREP':
        shell = ref(a[0]); out = []
        for f in reflist(args(shell)[0]): out += face_tris(f)
        return out
    if t == 'IFCFACEBASEDSURFACEMODEL':
        out = []
        for fs in reflist(a[0]):
            for f in reflist(args(fs)[0]): out += face_tris(f)
        return out
    if t in ('IFCBOOLEANCLIPPINGRESULT', 'IFCBOOLEANRESULT'):
        return item_tris(ref(a[1]), depth + 1)
    if t == 'IFCMAPPEDITEM':
        rmap = ref(a[0]); T = cto(ref(a[1]))
        ra = args(rmap); O = axis2p3d(ref(ra[0])); rep = ref(ra[1])
        M = T @ O; out = []
        for it in reflist(split(raw[rep][1])[3]):
            for tri in item_tris(it, depth + 1):
                out.append(tuple((M @ np.append(v, 1))[:3] for v in tri))
        return out
    raise ValueError('item ' + t)

def body_items(elem_id):
    a = args(elem_id)
    shp = ref(a[6]) if len(a) > 6 else None
    if not shp or typ(shp) != 'IFCPRODUCTDEFINITIONSHAPE': return []
    items = []
    for rep in reflist(args(shp)[2]):
        ra = args(rep)
        if ra[1].strip("'") == 'Body': items += reflist(ra[3])
    return items

def elem_tris(eid):
    a = args(eid)
    M = placement(ref(a[5]))
    tris = []
    for it in body_items(eid):
        for tri in item_tris(it):
            tris.append(tuple((M @ np.append(v, 1))[:3] for v in tri))
    return tris

if __name__ == '__main__':
    ifc_path, elems_path, out_path = sys.argv[1:4]
    raw = IfcFile(ifc_path)
    E = {e['id']: e for e in json.load(open(elems_path))}
    agg = collections.defaultdict(list)
    for parent, kids in raw.aggregates:
        agg[parent] += kids
    A = [e for e in E.values() if e['props'].get('STJV_4D_Activity ID')]
    out = {}; errs = collections.Counter(); errex = {}
    for k, e in enumerate(A):
        try:
            tris = elem_tris(e['id'])
            for c in agg.get(e['id'], []):
                tris += elem_tris(c)
            out[e['id']] = np.array(tris, dtype=np.float64).reshape(-1, 9) if tris else np.zeros((0, 9))
            if not tris: errs['empty'] += 1
        except Exception as ex:
            errs[str(ex)[:60]] += 1; errex[str(ex)[:60]] = e['id']
            out[e['id']] = np.zeros((0, 9))
        if k % 1000 == 0: print(k, flush=True)
    print(errs, errex)
    pickle.dump(out, open(out_path, 'wb'), protocol=5)
    tot = sum(len(v) for v in out.values()); print('triangles', tot)
