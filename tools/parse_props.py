import re, sys, json, collections
f = sys.argv[1]
ent = {}  # id -> (type, argstring)
rx = re.compile(r'^#(\d+)\s*=\s*([A-Z0-9_]+)\((.*)\);\s*$', re.S)
KEEP = {'IFCPROPERTYSINGLEVALUE','IFCPROPERTYSET','IFCRELDEFINESBYPROPERTIES','IFCRELCONTAINEDINSPATIALSTRUCTURE',
        'IFCBUILDINGSTOREY','IFCRELDEFINESBYTYPE','IFCRELAGGREGATES','IFCELEMENTQUANTITY','IFCQUANTITYAREA','IFCQUANTITYLENGTH'}
ELEM = {'IFCPLATE','IFCBUILDINGELEMENTPROXY','IFCSLAB','IFCCURTAINWALL','IFCWALL','IFCWALLSTANDARDCASE','IFCROOF','IFCMEMBER','IFCRAILING','IFCWINDOW','IFCCOVERING'}
buf = ''
with open(f, encoding='latin-1') as fh:
    for line in fh:
        buf += line
        if not buf.rstrip().endswith(';'):
            continue
        s = buf.strip(); buf = ''
        if not s.startswith('#'): continue
        m = rx.match(s)
        if not m: continue
        t = m.group(2)
        if t in KEEP or t in ELEM or t.endswith('TYPE') and t in ('IFCPLATETYPE','IFCBUILDINGELEMENTPROXYTYPE','IFCSLABTYPE','IFCCURTAINWALLTYPE','IFCWALLTYPE'):
            ent[int(m.group(1))] = (t, m.group(3))

def split(a):
    out, depth, cur, q = [], 0, '', False
    i = 0
    while i < len(a):
        c = a[i]
        if q:
            cur += c
            if c == "'":
                if i+1 < len(a) and a[i+1] == "'": cur += "'"; i += 1
                else: q = False
        elif c == "'": q = True; cur += c
        elif c == '(': depth += 1; cur += c
        elif c == ')': depth -= 1; cur += c
        elif c == ',' and depth == 0: out.append(cur.strip()); cur = ''
        else: cur += c
        i += 1
    out.append(cur.strip()); return out

def s(v):
    if v.startswith("'"): return v[1:-1].replace("''","'")
    return None
def refs(v): return [int(x) for x in re.findall(r'#(\d+)', v)]
def val(v):
    m = re.match(r"IFC[A-Z]+\((.*)\)$", v)
    if not m: return None
    x = m.group(1)
    if x.startswith("'"): return x[1:-1].replace("''","'")
    try: return float(x)
    except: return x

def decode(t):
    # IFC \X2\...\X0\ unicode
    return re.sub(r'\\X2\\([0-9A-F]+)\\X0\\', lambda m: ''.join(chr(int(m.group(1)[i:i+4],16)) for i in range(0,len(m.group(1)),4)), t) if t else t

elems = {}
for i,(t,a) in ent.items():
    if t in ELEM:
        p = split(a)
        elems[i] = dict(id=i, cls=t, guid=s(p[0]), name=decode(s(p[2])), objtype=decode(s(p[4])) if len(p)>4 else None, props={})
storey = {}
for i,(t,a) in ent.items():
    if t == 'IFCBUILDINGSTOREY':
        p = split(a); storey[i] = (decode(s(p[2])), p[9] if len(p)>9 else None)
for i,(t,a) in ent.items():
    if t == 'IFCRELCONTAINEDINSPATIALSTRUCTURE':
        p = split(a); st = refs(p[5])[0]
        for e in refs(p[4]):
            if e in elems: elems[e]['level'] = storey.get(st,(None,))[0]
    elif t == 'IFCRELAGGREGATES':
        p = split(a); parent = refs(p[4])[0]
        for e in refs(p[5]):
            if e in elems and parent in elems: elems[e]['parent'] = parent
def psetvals(pid):
    t,a = ent.get(pid,(None,None))
    out = {}
    if t == 'IFCPROPERTYSET':
        p = split(a)
        for r in refs(p[4]):
            tt,aa = ent.get(r,(None,None))
            if tt == 'IFCPROPERTYSINGLEVALUE':
                q = split(aa); out[decode(s(q[0]))] = decode(val(q[2])) if isinstance(val(q[2]),str) else val(q[2])
    elif t == 'IFCELEMENTQUANTITY':
        p = split(a)
        for r in refs(p[5]):
            tt,aa = ent.get(r,(None,None))
            if tt in ('IFCQUANTITYAREA','IFCQUANTITYLENGTH'):
                q = split(aa)
                try: out['Q:'+s(q[0])] = float(q[3])
                except: pass
    return out
cache = {}
for i,(t,a) in ent.items():
    if t == 'IFCRELDEFINESBYPROPERTIES':
        p = split(a); objs = refs(p[4]); ps = refs(p[5])[0]
        if ps not in cache: cache[ps] = psetvals(ps)
        for o in objs:
            if o in elems: elems[o]['props'].update(cache[ps])
json.dump(list(elems.values()), open(sys.argv[2],'w'))
print(len(elems), collections.Counter(e['cls'] for e in elems.values()))
