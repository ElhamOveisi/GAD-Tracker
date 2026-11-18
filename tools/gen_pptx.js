/**
 * GAD Glass Works — PPTX Status Report Generator
 * Reads live tracker.json and writes a one-page status deck.
 * Usage: node gen_pptx.js <tracker.json> <output.pptx> <img-dir>
 */
'use strict';
const pptxgen   = require('pptxgenjs');
const path      = require('path');
const fs        = require('fs');

// ── ARGS ──────────────────────────────────────────────────────────────────
const [,, trackerPath, outPath, imgDir] = process.argv;
if (!trackerPath || !outPath || !imgDir) {
  console.error('Usage: node gen_pptx.js <tracker.json> <output.pptx> <img-dir>');
  process.exit(1);
}

// ── applyTheme (bundled inline so the tool has no external skill dep) ──────
// Writes theme colors into the PPTX XML directly.
async function applyTheme(pptxPath, theme) {
  const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
  if (!AdmZip) return; // graceful skip if adm-zip missing (pptxgenjs already includes it)
  try {
    const zip = new AdmZip(pptxPath);
    const entry = zip.getEntry('ppt/theme/theme1.xml');
    if (!entry) return;
    let xml = entry.getData().toString('utf8');
    const c = theme.colors;
    const pairs = [
      ['dk1', c.dk1], ['lt1', c.lt1], ['dk2', c.dk2], ['lt2', c.lt2],
      ['accent1', c.accent1], ['accent2', c.accent2], ['accent3', c.accent3],
      ['accent4', c.accent4], ['accent5', c.accent5], ['accent6', c.accent6],
      ['hlink', c.hlink], ['folHlink', c.folHlink],
    ];
    for (const [key, val] of pairs) {
      xml = xml.replace(new RegExp(`(<a:${key}[^>]*><a:srgbClr val=")[^"]*(")`), `$1${val}$2`);
    }
    // theme name
    xml = xml.replace(/(<a:theme[^>]+name=")[^"]*(")/,
      `$1${theme.name.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}$2`);
    zip.updateFile('ppt/theme/theme1.xml', Buffer.from(xml, 'utf8'));
    zip.writeZip(pptxPath);
  } catch { /* non-fatal */ }
}

// ── LOAD TRACKER ──────────────────────────────────────────────────────────
// tracker.json is an array of arrays: [group, sub, desc, type, id, sqm, status]
const raw = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
// Support both array-of-arrays and array-of-objects (or {rows:[...]})
function parseRows(raw) {
  const data = Array.isArray(raw) ? raw : (raw.rows || []);
  if (!data.length) return [];
  if (Array.isArray(data[0])) {
    // array-of-arrays: [group, sub, desc, type, id, sqm, status]
    return data.map(r => ({
      group: r[0] || '',
      sub:   r[1] || '',
      sqm:   +r[5] || 0,
      status: (r[6] || '').trim(),
    }));
  }
  // array-of-objects
  return data.map(r => ({
    group:  r.group  || r[0] || '',
    sub:    r.sub    || r[1] || '',
    sqm:    +(r.sqm  || r.area || r[5]) || 0,
    status: (r.status || r[6] || '').trim(),
  }));
}

function normStatus(s) {
  s = (s || '').trim();
  if (!s) return 'No status';
  // case-insensitive match to known statuses
  const known = Object.keys(STATUS_COLOR);
  const m = known.find(k => k.toLowerCase() === s.toLowerCase());
  return m || s;
}

const rows = parseRows(raw);

// Status colors (must match dashboard)
const STATUS_COLOR = {
  'Installed':          '2e9e5b',
  'Delivered':          '9b59b6',
  'Bonded':             '2980b9',
  'Released for fabr':  'e91e8c',
  'Delivery to bond':   'e8892b',
  'Fabricated':         'f1c40f',
  'Late airfreight':    'f48fb1',
  'Broken':             'c8423b',
  'No status':          '7a5a48',
};
const STATUS_ORDER = Object.keys(STATUS_COLOR);

// Aggregate by status (normalise case)
const byStatus = {};
for (const r of rows) {
  const s = normStatus(r.status);
  if (!byStatus[s]) byStatus[s] = { n: 0, sqm: 0 };
  byStatus[s].n++;
  byStatus[s].sqm += r.sqm;
}

const TOTAL     = rows.length;
const TOTAL_SQM = rows.reduce((a, r) => a + r.sqm, 0);

// Build ordered status list (known first, then others)
const STATUSES = [];
for (const s of STATUS_ORDER) {
  if (byStatus[s]) STATUSES.push({ label: s, ...byStatus[s], color: STATUS_COLOR[s] });
}
for (const [s, v] of Object.entries(byStatus)) {
  if (!STATUS_COLOR[s]) STATUSES.push({ label: s, ...v, color: '888888' });
}

// Aggregate by group (col 0 in tracker = group name e.g. Staircase, Bridge…)
const byGroup = {};
for (const r of rows) {
  const g = r.group || 'Other';
  if (!byGroup[g]) byGroup[g] = 0;
  byGroup[g]++;
}
const GROUPS = Object.entries(byGroup)
  .sort((a, b) => b[1] - a[1])
  .map(([label, n]) => ({ label, n }));

const GP_COLORS = ['00C6A7', '2980b9', '9b59b6', 'e8892b', '7FB3C8'];

// Date
const now = new Date();
const DATE = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// ── THEME ─────────────────────────────────────────────────────────────────
const THEME = {
  name: 'GAD Midnight',
  headFontFace: 'Cambria',
  bodyFontFace: 'Calibri',
  colors: {
    dk1: '0A0F1E', lt1: 'FFFFFF',
    dk2: '1A2340', lt2: 'E8EDF5',
    accent1: '00C6A7', accent2: '2980b9', accent3: '9b59b6',
    accent4: 'e91e8c', accent5: 'f1c40f', accent6: 'e8892b',
    hlink: '00C6A7', folHlink: '7FB3C8',
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────
function pct(n) { return (100 * n / TOTAL).toFixed(1); }
function fmt(n) { return n.toLocaleString('en-US'); }
function fmtSqm(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

// ── PRESENTATION ──────────────────────────────────────────────────────────
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.3" x 7.5"
pres.author = 'GAD Project — BESIX/Six Construct JV';
pres.title  = 'GAD Glass Works — Installation Status';

const sl = pres.addSlide();

// Dark background
sl.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: '100%', h: '100%', fill: { color: '0A0F1E' } });

// Subtle grid lines
for (let i = 0; i < 15; i++) {
  sl.addShape(pres.ShapeType.line, {
    x: 0, y: 0.5 * i, w: 13.3, h: 0,
    line: { color: '1A2340', width: 0.5 },
  });
}

// ── HEADER ─────────────────────────────────────────────────────────────────
const LOGO_STRIP_H = 0.72;
const TITLE_BAND_H = 0.70;

// White logos strip
sl.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 13.3, h: LOGO_STRIP_H, fill: { color: 'FFFFFF' } });
sl.addShape(pres.ShapeType.line, { x: 0, y: LOGO_STRIP_H, w: 13.3, h: 0, line: { color: 'DDDDDD', width: 0.75 } });
// Dark title band
sl.addShape(pres.ShapeType.rect, { x: 0, y: LOGO_STRIP_H, w: 13.3, h: TITLE_BAND_H, fill: { color: '0A0F1E' } });

// Logos
const LOGOS = [
  { file: 'logo-dct.png',          aspect: 451/160 },
  { file: 'logo-time.png',         aspect: 156/160 },
  { file: 'logo-wsp.png',          aspect: 321/160 },
  { file: 'logo-sixconstruct.png', aspect: 782/160 },
  { file: 'logo-trojan.png',       aspect: 548/160 },
];
const LOGO_H    = 0.40;
const LOGO_PAD  = 0.14;
const TILE_GAP  = 0.14;
const tileWids  = LOGOS.map(l => l.aspect * LOGO_H + LOGO_PAD * 2);
const totalW    = tileWids.reduce((a,b)=>a+b,0) + TILE_GAP*(LOGOS.length-1);
let lx = (13.3 - totalW) / 2;
const LOGO_Y = (LOGO_STRIP_H - LOGO_H) / 2;
LOGOS.forEach((logo, i) => {
  const imgPath = path.join(imgDir, logo.file);
  if (fs.existsSync(imgPath)) {
    sl.addImage({ path: imgPath, x: lx + LOGO_PAD, y: LOGO_Y, w: logo.aspect * LOGO_H, h: LOGO_H });
  }
  lx += tileWids[i] + TILE_GAP;
});

// Title
sl.addText('GAD PROJECT — GLASS WORKS STATUS', {
  x: 0.4, y: LOGO_STRIP_H + 0.07, w: 9.5, h: 0.38,
  fontSize: 20, bold: true, color: 'FFFFFF', fontFace: 'Cambria', charSpacing: 1.5,
  isTextBox: true, margin: 0,
});
sl.addText('BIM Dashboard  ·  BESIX / Six Construct JV  ·  Issued for Management Review', {
  x: 0.4, y: LOGO_STRIP_H + 0.44, w: 9.0, h: 0.22,
  fontSize: 9.5, color: '7FB3C8', italic: true, fontFace: 'Calibri', isTextBox: true, margin: 0,
});
sl.addShape(pres.ShapeType.roundRect, {
  x: 10.9, y: LOGO_STRIP_H + 0.17, w: 2.05, h: 0.34,
  fill: { color: '00C6A7' }, line: { color: '00C6A7', width: 0 }, rectRadius: 0.06,
});
sl.addText(DATE, {
  x: 10.9, y: LOGO_STRIP_H + 0.18, w: 2.05, h: 0.32,
  fontSize: 10, bold: true, color: '0A0F1E', align: 'center', fontFace: 'Calibri', isTextBox: true, margin: 0,
});

// ── KPI CARDS ─────────────────────────────────────────────────────────────
const installed = STATUSES.find(s => s.label === 'Installed') || { n: 0, sqm: 0 };
const kpis = [
  { val: fmt(TOTAL),               label: 'Total Panels',  sub: fmtSqm(TOTAL_SQM) + ' m² total area' },
  { val: fmt(installed.n),         label: 'Installed',     sub: pct(installed.n) + '% of total panels' },
  { val: fmtSqm(installed.sqm),   label: 'm² Installed',  sub: (TOTAL_SQM > 0 ? (100*installed.sqm/TOTAL_SQM).toFixed(1) : '0') + '% of total area' },
];
kpis.forEach((k, i) => {
  const x = 0.35 + i * 4.3;
  sl.addShape(pres.ShapeType.roundRect, { x, y: 1.52, w: 4.0, h: 1.3, fill: { color: '111B30' }, line: { color: '1E2E50', width: 1 }, rectRadius: 0.1 });
  sl.addShape(pres.ShapeType.rect, { x, y: 1.52, w: 4.0, h: 0.06, fill: { color: '00C6A7' }, line: { color: '00C6A7', width: 0 } });
  sl.addText(k.val, { x: x+0.15, y: 1.60, w: 3.7, h: 0.60, fontSize: 38, bold: true, color: 'FFFFFF', fontFace: 'Cambria', isTextBox: true, margin: 0 });
  sl.addText(k.label, { x: x+0.15, y: 2.13, w: 3.7, h: 0.28, fontSize: 11, bold: true, color: '00C6A7', fontFace: 'Calibri', isTextBox: true, margin: 0, charSpacing: 1 });
  sl.addText(k.sub, { x: x+0.15, y: 2.40, w: 3.7, h: 0.22, fontSize: 9, color: '7FB3C8', italic: true, fontFace: 'Calibri', isTextBox: true, margin: 0 });
});

// ── PROGRESS BAR ──────────────────────────────────────────────────────────
const BAR_X=0.35, BAR_Y=2.98, BAR_W=12.6, BAR_H=0.30;
sl.addShape(pres.ShapeType.roundRect, { x:BAR_X, y:BAR_Y, w:BAR_W, h:BAR_H, fill:{color:'1A2340'}, line:{color:'1A2340',width:0}, rectRadius:0.05 });
let curX = BAR_X;
for (const s of STATUSES) {
  const segW = BAR_W * s.n / TOTAL;
  if (segW > 0.01) {
    sl.addShape(pres.ShapeType.rect, { x:curX, y:BAR_Y, w:segW, h:BAR_H, fill:{color:s.color}, line:{color:s.color,width:0} });
  }
  curX += segW;
}
sl.addText('OVERALL INSTALLATION PROGRESS', { x:BAR_X, y:BAR_Y-0.22, w:8, h:0.2, fontSize:8, bold:true, color:'7FB3C8', charSpacing:1.5, fontFace:'Calibri', isTextBox:true, margin:0 });
sl.addText(pct(installed.n)+'%', { x:10.5, y:BAR_Y-0.22, w:2.4, h:0.2, fontSize:8, bold:true, color:'00C6A7', align:'right', fontFace:'Calibri', isTextBox:true, margin:0 });

// ── STATUS TABLE ──────────────────────────────────────────────────────────
const TBL_X=0.35, TBL_Y=3.46;
sl.addText('STATUS BREAKDOWN', { x:TBL_X, y:TBL_Y, w:7.5, h:0.22, fontSize:8, bold:true, color:'7FB3C8', charSpacing:1.5, fontFace:'Calibri', isTextBox:true, margin:0 });

// Dynamic row height: fit all statuses between TBL_Y+0.28 and footer (7.10)
const ROW_H = Math.min(0.49, (7.10 - TBL_Y - 0.28) / Math.max(STATUSES.length, 1));
STATUSES.forEach((s, i) => {
  const rowY = TBL_Y + 0.28 + i * ROW_H;
  const barMaxW = 5.4;
  const barW = Math.max(0.05, barMaxW * s.n / TOTAL);
  const dotOff = ROW_H * 0.22;
  const bgH = ROW_H - 0.03;

  sl.addShape(pres.ShapeType.rect, { x:TBL_X, y:rowY-0.02, w:7.5, h:bgH, fill:{color: i%2===0 ? '0E1829':'111B30'}, line:{color:'1A2340',width:0} });
  sl.addShape(pres.ShapeType.ellipse, { x:TBL_X+0.1, y:rowY+dotOff, w:0.17, h:0.17, fill:{color:s.color}, line:{color:s.color,width:0} });
  sl.addText(s.label, { x:TBL_X+0.36, y:rowY, w:1.62, h:ROW_H-0.04, fontSize:10.5, color:'FFFFFF', fontFace:'Calibri', isTextBox:true, margin:0, valign:'middle' });
  sl.addShape(pres.ShapeType.rect, { x:TBL_X+2.0, y:rowY+dotOff+0.01, w:barMaxW, h:0.12, fill:{color:'1A2340'}, line:{color:'1A2340',width:0} });
  sl.addShape(pres.ShapeType.rect, { x:TBL_X+2.0, y:rowY+dotOff+0.01, w:barW, h:0.12, fill:{color:s.color}, line:{color:s.color,width:0} });
  sl.addText(fmt(s.n), { x:TBL_X+7.0, y:rowY, w:0.5, h:ROW_H-0.04, fontSize:10.5, bold:true, color:'FFFFFF', align:'right', fontFace:'Calibri', isTextBox:true, margin:0, valign:'middle' });
  sl.addText(pct(s.n)+'%', { x:TBL_X+7.52, y:rowY, w:0.6, h:ROW_H-0.04, fontSize:10.5, color:'7FB3C8', align:'right', fontFace:'Calibri', isTextBox:true, margin:0, valign:'middle' });
  sl.addText(fmtSqm(s.sqm)+' m²', { x:TBL_X+8.14, y:rowY, w:1.1, h:ROW_H-0.04, fontSize:9.5, color:'7FB3C8', italic:true, align:'right', fontFace:'Calibri', isTextBox:true, margin:0, valign:'middle' });
});

// ── GROUP BREAKDOWN ────────────────────────────────────────────────────────
const GP_X=9.9, GP_Y=3.46;
sl.addText('BY STRUCTURE', { x:GP_X, y:GP_Y, w:3.05, h:0.22, fontSize:8, bold:true, color:'7FB3C8', charSpacing:1.5, fontFace:'Calibri', isTextBox:true, margin:0 });

const GP_ROW_H = Math.min(0.63, (7.10 - GP_Y - 0.28) / Math.max(GROUPS.length, 1));
GROUPS.forEach((g, i) => {
  const gy = GP_Y + 0.28 + i * GP_ROW_H;
  const barW = 2.8 * g.n / TOTAL;
  const col = GP_COLORS[i % GP_COLORS.length];
  const labelH = GP_ROW_H * 0.42;

  sl.addShape(pres.ShapeType.rect, { x:GP_X, y:gy-0.02, w:3.05, h:GP_ROW_H-0.04, fill:{color: i%2===0 ? '0E1829':'111B30'}, line:{color:'1A2340',width:0} });
  sl.addText(g.label, { x:GP_X+0.1, y:gy, w:1.7, h:labelH, fontSize:11, color:'FFFFFF', fontFace:'Calibri', isTextBox:true, margin:0 });
  sl.addText(fmt(g.n)+' panels', { x:GP_X+0.1, y:gy+labelH, w:1.7, h:labelH, fontSize:9, color:'7FB3C8', fontFace:'Calibri', isTextBox:true, margin:0 });
  sl.addText(pct(g.n)+'%', { x:GP_X+2.5, y:gy, w:0.5, h:labelH, fontSize:11, bold:true, color:col, align:'right', fontFace:'Calibri', isTextBox:true, margin:0 });
  const barY = gy + GP_ROW_H - 0.18;
  sl.addShape(pres.ShapeType.rect, { x:GP_X+0.1, y:barY, w:2.8, h:0.07, fill:{color:'1A2340'}, line:{color:'1A2340',width:0} });
  sl.addShape(pres.ShapeType.rect, { x:GP_X+0.1, y:barY, w:Math.max(0.03,barW), h:0.07, fill:{color:col}, line:{color:col,width:0} });
});

// Divider
sl.addShape(pres.ShapeType.line, { x:9.75, y:3.38, w:0, h:3.67, line:{color:'1E2E50',width:1} });

// ── FOOTER ────────────────────────────────────────────────────────────────
sl.addShape(pres.ShapeType.rect, { x:0, y:7.15, w:13.3, h:0.35, fill:{color:'060C17'}, line:{color:'060C17',width:0} });
sl.addText('Source: GAD-FINO_GLASS_TRACKER.xlsx  ·  CONFIDENTIAL — BESIX / Six Construct JV', {
  x:0.35, y:7.18, w:12.6, h:0.24, fontSize:8, color:'3A5070', italic:true, fontFace:'Calibri', isTextBox:true, margin:0,
});

// ── WRITE ─────────────────────────────────────────────────────────────────
(async () => {
  await pres.writeFile({ fileName: outPath });
  await applyTheme(outPath, THEME);
  console.log('OK:', outPath);
})().catch(e => { console.error(e.message); process.exit(1); });
