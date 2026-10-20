// Glass Works Tracker server (no dependencies).
//
// Persistent data lives on the Railway volume (RAILWAY_VOLUME_MOUNT_PATH, set
// automatically when a volume is attached) or DATA_DIR, so tracker uploads
// survive redeploys. Layout inside the storage folder:
//   tracker.json          current tracker { rows, info }
//   history/<id>.json     every previous version, never deleted
//   seed.json             hash of the bundled tracker last applied
//
// The model geometry (public/data/model.bin, meta.json) ships with the code.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC = path.join(__dirname, "public");
const BUNDLED_TRACKER = path.join(PUBLIC, "data", "tracker.json");
const BUNDLED_CONFIG = path.join(PUBLIC, "data", "config.json");
const STORE =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DATA_DIR ||
  path.join(__dirname, "storage");
const HISTORY = path.join(STORE, "history");
const CURRENT = path.join(STORE, "tracker.json");
const SEED = path.join(STORE, "seed.json");
const PORT = process.env.PORT || 3000;
const UPLOAD_KEY = process.env.UPLOAD_KEY || "";
const MAX_BODY = 20 * 1024 * 1024;
const ON_VOLUME = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- storage helpers ----------
function writeAtomic(file, data) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => new Date().toISOString().replace(/[:.]/g, "-");

function archiveCurrent() {
  if (!fs.existsSync(CURRENT)) return;
  const cur = readJSON(CURRENT);
  const id = (cur.info && cur.info.id) || newId();
  const file = path.join(HISTORY, id + ".json");
  if (!fs.existsSync(file)) writeAtomic(file, JSON.stringify(cur));
}

function saveTracker(rows, info) {
  archiveCurrent();
  const doc = { rows, info: { ...info, id: newId(), savedAt: new Date().toISOString(), rows: rows.length } };
  writeAtomic(CURRENT, JSON.stringify(doc));
  // keep a copy of the new version in history too, so history is complete
  writeAtomic(path.join(HISTORY, doc.info.id + ".json"), JSON.stringify(doc));
  return doc.info;
}

function initStore() {
  fs.mkdirSync(HISTORY, { recursive: true });
  // Clean up temp files left by an interrupted write
  for (const dir of [STORE, HISTORY])
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".tmp")) fs.rmSync(path.join(dir, f), { force: true });

  const bundledText = fs.readFileSync(BUNDLED_TRACKER, "utf8");
  const bundledHash = sha(bundledText);
  const seed = fs.existsSync(SEED) ? readJSON(SEED) : null;
  let source = "Bundled tracker";
  try { source = readJSON(BUNDLED_CONFIG).source || source; } catch {}

  if (!fs.existsSync(CURRENT)) {
    // First boot on this volume: start from the tracker that ships with the code
    saveTracker(JSON.parse(bundledText), { source: source.replace(/^Tracker:\s*/, ""), by: "deploy", method: "bundled" });
    console.log("Storage: created tracker from bundled data");
  } else if (seed && seed.hash !== bundledHash) {
    // A newer tracker was pushed through GitHub: apply it, keeping the old one in history
    saveTracker(JSON.parse(bundledText), { source: source.replace(/^Tracker:\s*/, ""), by: "deploy", method: "bundled" });
    console.log("Storage: bundled tracker changed in the code, applied it (previous version kept in history)");
  } else {
    console.log("Storage: kept existing tracker on the volume");
  }
  writeAtomic(SEED, JSON.stringify({ hash: bundledHash, at: new Date().toISOString() }));
}

// ---------- validation ----------
function validRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 200000) return false;
  return rows.every(
    (r) => Array.isArray(r) && r.length === 7 && typeof r[4] === "string" && r[4].trim() && typeof r[5] === "number" &&
      r.every((v, i) => (i === 5 ? Number.isFinite(v) : typeof v === "string" && v.length < 500))
  );
}
function keyOK(req) {
  if (!UPLOAD_KEY) return false;
  const got = Buffer.from(String(req.headers["x-upload-key"] || ""));
  const want = Buffer.from(UPLOAD_KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- http ----------
function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function api(req, res, p) {
  if (p === "/api/tracker" && req.method === "GET") {
    return send(res, 200, fs.readFileSync(CURRENT, "utf8"));
  }
  if (p === "/api/status" && req.method === "GET") {
    return send(res, 200, { uploadsEnabled: Boolean(UPLOAD_KEY), persistent: ON_VOLUME });
  }
  if (p === "/api/tracker" && req.method === "POST") {
    if (!UPLOAD_KEY) return send(res, 403, { error: "Saving is switched off. Set the UPLOAD_KEY variable in Railway to turn it on." });
    if (!keyOK(req)) return send(res, 401, { error: "Wrong upload password." });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Couldn't read the upload." }); }
    if (!validRows(body.rows)) return send(res, 400, { error: "The tracker rows aren't in the expected format." });
    const info = saveTracker(body.rows, {
      source: String(body.filename || "upload").slice(0, 200),
      by: String(body.by || "").slice(0, 100),
      method: "upload",
    });
    console.log(`Tracker saved: ${info.rows} rows from ${info.source}`);
    return send(res, 200, { ok: true, info });
  }
  if (p === "/api/history" && req.method === "GET") {
    const list = fs.readdirSync(HISTORY).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
      try { return readJSON(path.join(HISTORY, f)).info; } catch { return null; }
    }).filter(Boolean);
    return send(res, 200, list);
  }
  const m = p.match(/^\/api\/history\/([\w-]+)\/restore$/);
  if (m && req.method === "POST") {
    if (!UPLOAD_KEY) return send(res, 403, { error: "Saving is switched off. Set the UPLOAD_KEY variable in Railway to turn it on." });
    if (!keyOK(req)) return send(res, 401, { error: "Wrong upload password." });
    const file = path.join(HISTORY, m[1] + ".json");
    if (!fs.existsSync(file)) return send(res, 404, { error: "That version doesn't exist." });
    const old = readJSON(file);
    const info = saveTracker(old.rows, { source: old.info.source, by: "restore", method: "restore", restoredFrom: m[1] });
    return send(res, 200, { ok: true, info });
  }
  return send(res, 404, { error: "Not found" });
}

function serveStatic(req, res, urlPath) {
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", "text/plain");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

initStore();
http
  .createServer(async (req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "Bad request", "text/plain"); }
    try {
      if (p === "/health") return send(res, 200, "ok", "text/plain");
      if (p.startsWith("/api/")) return await api(req, res, p);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
      return serveStatic(req, res, p);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "Server error" });
    }
  })
  .listen(PORT, () => {
    console.log(`Glass Works Tracker on port ${PORT}`);
    console.log(`Storage folder: ${STORE}${ON_VOLUME ? "" : "  (WARNING: not a volume, uploads will be lost on redeploy)"}`);
    if (!UPLOAD_KEY) console.log("UPLOAD_KEY not set: saving trackers from the page is switched off");
  });
