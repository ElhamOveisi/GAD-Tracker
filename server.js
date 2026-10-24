// Glass Works Tracker server (no dependencies).
//
// Persistent data lives on the Railway volume (RAILWAY_VOLUME_MOUNT_PATH, set
// automatically when a volume is attached) or DATA_DIR, so tracker uploads
// survive redeploys. Layout inside the storage folder:
//   tracker.json          current tracker { rows, info }
//   history/<id>.json     every previous version, never deleted
//   seed.json             hashes of the bundled tracker/model last applied
//   models/<id>/          every model version (model.bin, meta.json, info.json)
//   models/current.json   which model version is shown
//   models/job.json       state of the latest IFC conversion
//   uploads/              IFC files while they are being converted
//
// The model that ships with the code (public/data/model.bin, meta.json) is copied
// in as the first model version.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

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
const MODELS = path.join(STORE, "models");
const UPLOADS = path.join(STORE, "uploads");
const MODEL_CURRENT = path.join(MODELS, "current.json");
const JOB = path.join(MODELS, "job.json");
const BUNDLED_MODEL = path.join(PUBLIC, "data", "model.bin");
const BUNDLED_META = path.join(PUBLIC, "data", "meta.json");
const PYTHON = process.env.PYTHON || "python3";
const MAX_IFC = 2 * 1024 * 1024 * 1024; // 2 GB
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
  // ----- model -----
  fs.mkdirSync(MODELS, { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  for (const d of fs.readdirSync(MODELS)) if (d.endsWith(".tmp")) fs.rmSync(path.join(MODELS, d), { recursive: true, force: true });
  for (const f of fs.readdirSync(UPLOADS)) fs.rmSync(path.join(UPLOADS, f), { force: true });
  const modelHash = sha(fs.readFileSync(BUNDLED_META, "utf8")) + sha(fs.readFileSync(BUNDLED_MODEL).toString("base64"));
  let cfgStamp = "";
  try { cfgStamp = readJSON(BUNDLED_CONFIG).stamp || ""; } catch {}
  const modelName = (cfgStamp.match(/Model:\s*([^·(]+)/) || [, "Model in code"])[1].trim();
  if (!fs.existsSync(MODEL_CURRENT) || (seed && seed.modelHash && seed.modelHash !== modelHash) || (seed && !seed.modelHash && !fs.existsSync(MODEL_CURRENT))) {
    const id = "m-" + newId();
    const dir = path.join(MODELS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(BUNDLED_MODEL, path.join(dir, "model.bin"));
    fs.copyFileSync(BUNDLED_META, path.join(dir, "meta.json"));
    const panels = readJSON(BUNDLED_META).length;
    writeAtomic(path.join(dir, "info.json"), JSON.stringify({ id, source: modelName, savedAt: new Date().toISOString(), panels, method: "bundled" }));
    writeAtomic(MODEL_CURRENT, JSON.stringify({ id }));
    console.log("Storage: model from the code set as current (" + id + ")");
  } else {
    console.log("Storage: kept current model " + readJSON(MODEL_CURRENT).id);
  }
  if (fs.existsSync(JOB)) {
    const job = readJSON(JOB);
    if (job.state === "running") writeAtomic(JOB, JSON.stringify({ ...job, state: "failed", error: "The server restarted during the conversion. Please upload the IFC again.", finishedAt: new Date().toISOString() }));
  }
  writeAtomic(SEED, JSON.stringify({ hash: bundledHash, modelHash, at: new Date().toISOString() }));
}

// ---------- model conversion ----------
const modelInfo = (id) => readJSON(path.join(MODELS, id, "info.json"));
const currentModel = () => modelInfo(readJSON(MODEL_CURRENT).id);
const readJob = () => (fs.existsSync(JOB) ? readJSON(JOB) : { state: "idle" });
const setJob = (j) => writeAtomic(JOB, JSON.stringify(j));

function startConversion(id, ifcPath, filename, sizeBytes) {
  const tmp = path.join(MODELS, id + ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const job = { id, state: "running", file: filename, sizeMB: Math.round(sizeBytes / 1e5) / 10, step: "Starting", startedAt: new Date().toISOString() };
  setJob(job);
  const child = spawn(PYTHON, [path.join(__dirname, "tools", "build_model.py"), ifcPath, tmp], { stdio: ["ignore", "pipe", "pipe"] });
  let errTail = "", panels = 0;
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.startsWith("STEP ")) { job.step = line.slice(5).trim(); setJob(job); }
      if (line.startsWith("PANELS ")) panels = parseInt(line.slice(7), 10) || 0;
    }
  });
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  const finish = (ok, error) => {
    fs.rmSync(ifcPath, { force: true });
    if (ok) {
      fs.renameSync(tmp, path.join(MODELS, id));
      writeAtomic(path.join(MODELS, id, "info.json"), JSON.stringify({ id, source: filename, savedAt: new Date().toISOString(), panels, method: "upload", sizeMB: job.sizeMB }));
      writeAtomic(MODEL_CURRENT, JSON.stringify({ id }));
      setJob({ ...job, state: "done", step: "Done", panels, finishedAt: new Date().toISOString() });
      console.log(`Model converted: ${filename}, ${panels} panels (${id})`);
    } else {
      fs.rmSync(tmp, { recursive: true, force: true });
      setJob({ ...job, state: "failed", error, finishedAt: new Date().toISOString() });
      console.error(`Model conversion failed for ${filename}: ${error}`);
    }
  };
  child.on("error", (e) => finish(false, "The converter couldn't start (" + e.message + "). Is Python installed on the server?"));
  child.on("close", (code) => {
    if (code === 0) return finish(true);
    const lines = errTail.trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1] || "unknown error";
    finish(false, /MemoryError|Killed/.test(errTail) || code === 137 || code === null
      ? "The server ran out of memory converting this IFC. Give the service more memory in Railway, or export only the glass elements."
      : last);
  });
}

function receiveIFC(req, res) {
  const filename = String(req.headers["x-filename"] || "model.ifc").replace(/[^\w.\- ()]/g, "_").slice(0, 200);
  if (!/\.ifc$/i.test(filename)) return send(res, 400, { error: "Please choose an .ifc file." });
  if (readJob().state === "running") return send(res, 409, { error: "Another IFC is being converted. Try again when it has finished." });
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_IFC) return send(res, 413, { error: "That file is over 2 GB." });
  const id = "m-" + newId();
  const ifcPath = path.join(UPLOADS, id + ".ifc");
  const out = fs.createWriteStream(ifcPath);
  let size = 0, aborted = false, head = "";
  req.on("data", (c) => {
    size += c.length;
    if (head.length < 64) head += c.toString("latin1", 0, Math.min(c.length, 64));
    if (size > MAX_IFC && !aborted) { aborted = true; out.destroy(); fs.rmSync(ifcPath, { force: true }); send(res, 413, { error: "That file is over 2 GB." }); req.destroy(); }
  });
  req.pipe(out);
  req.on("aborted", () => { aborted = true; out.destroy(); fs.rmSync(ifcPath, { force: true }); });
  out.on("finish", () => {
    if (aborted) return;
    if (!head.startsWith("ISO-10303-21")) { fs.rmSync(ifcPath, { force: true }); return send(res, 400, { error: "That file isn't an IFC (STEP) file." }); }
    startConversion(id, ifcPath, filename, size);
    send(res, 202, { ok: true, id });
  });
  out.on("error", (e) => { if (!aborted) { aborted = true; fs.rmSync(ifcPath, { force: true }); send(res, 500, { error: "Couldn't store the upload: " + e.message }); } });
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
  if (p === "/api/model" && req.method === "GET") return send(res, 200, currentModel());
  if (p === "/api/model/job" && req.method === "GET") return send(res, 200, readJob());
  if (p === "/api/model" && req.method === "POST") {
    if (!UPLOAD_KEY) { req.resume(); return send(res, 403, { error: "Saving is switched off. Set the UPLOAD_KEY variable in Railway to turn it on." }); }
    if (!keyOK(req)) { req.resume(); return send(res, 401, { error: "Wrong upload password." }); }
    return receiveIFC(req, res);
  }
  if (p === "/api/model/history" && req.method === "GET") {
    const list = fs.readdirSync(MODELS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith(".tmp"))
      .map((d) => { try { return modelInfo(d.name); } catch { return null; } })
      .filter(Boolean).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    return send(res, 200, list);
  }
  const mf = p.match(/^\/api\/model\/files\/(m-[\w-]+)\/(model\.bin|meta\.json)$/);
  if (mf && req.method === "GET") {
    const file = path.join(MODELS, mf[1], mf[2]);
    if (!fs.existsSync(file)) return send(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": mf[2].endsWith(".json") ? TYPES[".json"] : TYPES[".bin"], "Content-Length": fs.statSync(file).size, "Cache-Control": "public, max-age=31536000, immutable" });
    return fs.createReadStream(file).pipe(res);
  }
  const mr = p.match(/^\/api\/model\/(m-[\w-]+)\/restore$/);
  if (mr && req.method === "POST") {
    if (!UPLOAD_KEY) return send(res, 403, { error: "Saving is switched off. Set the UPLOAD_KEY variable in Railway to turn it on." });
    if (!keyOK(req)) return send(res, 401, { error: "Wrong upload password." });
    if (!fs.existsSync(path.join(MODELS, mr[1], "info.json"))) return send(res, 404, { error: "That model version doesn't exist." });
    writeAtomic(MODEL_CURRENT, JSON.stringify({ id: mr[1] }));
    return send(res, 200, { ok: true, info: modelInfo(mr[1]) });
  }
  if (p === "/api/history" && req.method === "GET") {
    const list = fs.readdirSync(HISTORY).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
      try { return readJSON(path.join(HISTORY, f)).info; } catch { return null; }
    }).filter(Boolean);
    return send(res, 200, list);
  }
  const dl = p.match(/^\/api\/history\/([\w-]+)\/download$/);
  if (dl && req.method === "GET") {
    const file = path.join(HISTORY, dl[1] + ".json");
    if (!fs.existsSync(file)) return send(res, 404, { error: "That version doesn't exist." });
    const doc = readJSON(file);
    const cell = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [["Full name", "Sub group", "Description", "TYPE", "STJV_4D_Activity ID", "Sqm", "STJV_4D_Status"].join(",")];
    for (const r of doc.rows) lines.push(r.map(cell).join(","));
    const base = String((doc.info && doc.info.source) || "tracker").replace(/\.(xlsx|csv)$/i, "").replace(/[^\w.\- ()]/g, "_");
    const stamp = String((doc.info && doc.info.savedAt) || "").slice(0, 16).replace(/[:T]/g, "-");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}_${stamp}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.end("\uFEFF" + lines.join("\r\n") + "\r\n"); // BOM so Excel reads UTF-8
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
