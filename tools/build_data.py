"""Rebuild the dashboard data from a Revit IFC export and the tracker Excel.

Usage:
    python tools/build_data.py MODEL.ifc TRACKER.xlsx [--stamp "text shown under the title"]

Writes public/data/model.bin, meta.json, tracker.json and config.json.
Needs Python 3.10+ with numpy and openpyxl (pip install numpy openpyxl).
"""
import argparse, gzip, json, os, pickle, re, struct, subprocess, sys, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'data')

def build_raw(ifc, path):
    rx = re.compile(r'^#(\d+)\s*=\s*([A-Z0-9_]+)\((.*)\);\s*$', re.S)
    raw, buf = {}, ''
    with open(ifc, encoding='latin-1') as fh:
        for line in fh:
            buf += line
            if not buf.rstrip().endswith(';'): continue
            s = buf.strip(); buf = ''
            m = rx.match(s)
            if m: raw[int(m.group(1))] = (m.group(2), m.group(3))
    pickle.dump(raw, open(path, 'wb'), protocol=5)

def pack(work):
    T = pickle.load(open(os.path.join(work, 'tris.pkl'), 'rb'))
    E = {e['id']: e for e in json.load(open(os.path.join(work, 'elems.json')))}
    ids = [k for k in T if len(T[k])]
    allp = np.concatenate([T[k].reshape(-1, 3) for k in ids])
    lo, hi = allp.min(0), allp.max(0); scale = (hi - lo).max() / 65000.0
    vc, tc, P, I, meta = [], [], [], [], []
    for k in ids:
        q = np.round((T[k].reshape(-1, 3) - lo) / scale).astype(np.int32)
        uq, inv = np.unique(q, axis=0, return_inverse=True)
        tri = inv.reshape(-1, 3)
        tri = tri[(tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])]
        vc.append(len(uq)); tc.append(len(tri))
        P.append((uq - 32500).astype(np.int16)); I.append(tri.astype(np.uint16))
        e = E[k]; p = e['props']; n = p.get('STJV_1D_Element_Notes')
        meta.append([p['STJV_4D_Activity ID'].strip(), n if n in ('P1', 'P2', 'P3', 'P4') else '',
                     e['guid'], round(p.get('Area') or 0, 3), e.get('objtype') or ''])
    hdr = struct.pack('<I', len(ids)) + np.array(vc, np.uint32).tobytes() + np.array(tc, np.uint32).tobytes()
    hdr += struct.pack('<4f', *lo[:3], scale)
    body = np.concatenate(P).tobytes()
    if len(body) % 4: body += b'\0' * (4 - len(body) % 4)
    open(os.path.join(OUT, 'model.bin'), 'wb').write(gzip.compress(hdr + body + np.concatenate(I).tobytes(), 9))
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), separators=(',', ':'))
    return len(ids)

def tracker(xlsx):
    import openpyxl
    ws = openpyxl.load_workbook(xlsx, data_only=True, read_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    h = [str(x or '').strip().lower() for x in rows[0]]
    def find(*keys):
        for i, x in enumerate(h):
            if any(k in x for k in keys): return i
        return -1
    iId, iSt, iSq = find('activity id'), find('status'), find('sqm', 'area')
    iG, iD, iT = find('full name', 'group'), find('description'), find('type')
    iS = next((i for i, x in enumerate(h) if x in ('sub group', 'subgroup')), 1)
    if iId < 0 or iSt < 0: sys.exit('Tracker: could not find the Activity ID and Status columns in row 1')
    g = lambda r, i: '' if i < 0 or r[i] is None else str(r[i]).strip()
    out = []
    for r in rows[1:]:
        if not g(r, iId): continue
        try: sqm = round(float(r[iSq] or 0), 3)
        except (TypeError, ValueError): sqm = 0
        out.append([g(r, iG), g(r, iS), g(r, iD), g(r, iT), g(r, iId), sqm, g(r, iSt)])
    json.dump(out, open(os.path.join(OUT, 'tracker.json'), 'w'), separators=(',', ':'))
    return len(out)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('ifc'); ap.add_argument('xlsx'); ap.add_argument('--stamp', default=None)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        print('Reading element properties…')
        subprocess.run([sys.executable, os.path.join(HERE, 'parse_props.py'), a.ifc, os.path.join(work, 'elems.json')], check=True)
        print('Reading geometry records…')
        build_raw(a.ifc, os.path.join(work, 'raw.pkl'))
        print('Converting geometry (about a minute)…')
        subprocess.run([sys.executable, os.path.join(HERE, 'geom.py')], cwd=work, check=True)
        n = pack(work)
    t = tracker(a.xlsx)
    stamp = a.stamp or f'Model: {os.path.basename(a.ifc)} · Tracker: {os.path.basename(a.xlsx)}'
    json.dump({'stamp': stamp, 'source': 'Tracker: ' + os.path.basename(a.xlsx)},
              open(os.path.join(OUT, 'config.json'), 'w'), ensure_ascii=False, indent=2)
    print(f'Done: {n} model panels, {t} tracker rows → public/data')
