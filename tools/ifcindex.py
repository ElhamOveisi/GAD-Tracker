"""Low-memory random access to the records of an IFC (STEP) file.

Instead of loading every record into memory, the file is memory-mapped and
only the byte offset of each record is kept (about 12 bytes per record).
Records are read and decoded on demand.
"""
import mmap
import re
from array import array
from functools import lru_cache

_HEAD = re.compile(rb'#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(')


class IfcFile:
    def __init__(self, path):
        self._fh = open(path, 'rb')
        self._mm = mmap.mmap(self._fh.fileno(), 0, access=mmap.ACCESS_READ)
        ids, offs = array('q'), array('q')
        self.aggregates = []  # (relating, [related]) from IFCRELAGGREGATES
        mm = self._mm
        pos, n = 0, len(mm)
        # Records start with "#<id>=" at the beginning of a line in exporter output;
        # scan line starts and accept those that look like a record header.
        while pos < n:
            end = mm.find(b'\n', pos)
            if end < 0: end = n
            if mm[pos:pos + 1] == b'#':
                m = _HEAD.match(mm, pos, min(end, pos + 80))
                if m:
                    ids.append(int(m.group(1))); offs.append(pos)
                    if m.group(2) == b'IFCRELAGGREGATES':
                        self._agg_pending = getattr(self, '_agg_pending', [])
                        self._agg_pending.append(int(m.group(1)))
            pos = end + 1
        maxid = max(ids) if ids else 0
        self._off = array('q', bytes(8 * (maxid + 1)))
        for i, o in zip(ids, offs):
            self._off[i] = o + 1  # 0 means "missing"
        del ids, offs
        for rid in getattr(self, '_agg_pending', []):
            t, a = self[rid]
            refs = [int(x) for x in re.findall(r'#(\d+)', a)]
            # args: guid, owner, name, desc, relating, (related...)
            if len(refs) >= 3: self.aggregates.append((refs[1], refs[2:]))
        self._agg_pending = []

    def _record(self, i):
        if i >= len(self._off) or not self._off[i]:
            raise KeyError(i)
        start = self._off[i] - 1
        mm = self._mm
        # end of record: ';' at end of a line, outside quotes
        p = start; q = False; n = len(mm)
        while p < n:
            c = mm[p]
            if c == 39:  # '
                q = not q
            elif c == 59 and not q:  # ;
                break
            p += 1
        rec = mm[start:p].decode('latin-1')
        m = re.match(r'#\d+\s*=\s*([A-Z0-9_]+)\s*\((.*)\)\s*$', rec, re.S)
        if not m: raise KeyError(i)
        return m.group(1), m.group(2)

    @lru_cache(maxsize=300000)
    def __getitem__(self, i):
        return self._record(i)

    def get(self, i, default=None):
        try: return self[i]
        except KeyError: return default

    def __contains__(self, i):
        return i < len(self._off) and bool(self._off[i])
