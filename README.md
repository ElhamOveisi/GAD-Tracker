# GAD Glass Works Tracker

A web dashboard for the GAD glass works. It shows the glass model in 3D, coloured by each panel's status from the tracker, with:

- **3D Model**: filter by group, sub group, status or Activity ID. Click a panel to see its details; double-click to zoom to it.
- **Summary**: where the panels are, as percentages at each status by group and sub group (by panel count or m²).
- **Data Checks**: panels in the model but not the tracker (and the reverse), duplicates, status spelling, area differences, plus the saved tracker and model versions.

Model panels are linked to tracker rows by `STJV_4D_Activity ID`. Lift panels share IDs across lifts, so they are linked by lift (`STJV_1D_Element_Notes` P1–P4) plus Activity ID.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** → pick this repo.
   Railway builds the included `Dockerfile` (Node for the site, Python + numpy for converting IFC files).
2. **Attach a volume** to the service with mount path **`/data`**.
   Railway sets `RAILWAY_VOLUME_MOUNT_PATH` and the server stores everything there automatically.
3. **Variables** → add `UPLOAD_KEY` = a password of your choice. It's needed to save a new tracker or upload a new IFC from the page. Without it, saving is switched off (viewing still works).
4. **Settings → Networking → Generate Domain** for the public link.

Every push to `main` redeploys automatically. Data on the volume is kept across redeploys.

## Updating the data

### New tracker
**Load new tracker** → check the preview → enter the upload password → **Save for everyone**.

### New model
**Upload new IFC** → enter the upload password → **Upload and convert**. The server converts it in the background (about 2 minutes for a 250 MB IFC); then click **Show new model**.
Export the IFC from Revit with Revit property sets included, so `STJV_4D_Activity ID` comes through.

### Undo
**Data Checks → Tracker versions / Model versions** list every saved version. **Restore** makes an older one current again; nothing is ever deleted.

## How the data is kept

| What | Where | Survives redeploy |
|---|---|---|
| Current tracker | volume: `/data/tracker.json` | Yes |
| Every previous tracker version | volume: `/data/history/` | Yes, never deleted |
| Current model + every model version | volume: `/data/models/` | Yes, never deleted |
| Model and tracker that ship with the code | `public/data/` in this repo | Yes (in the code) |

- On the first start with an empty volume, the tracker and model in `public/data/` are copied to the volume.
- If a changed `public/data/tracker.json` or model is later pushed through GitHub, it's applied on deploy as a new current version (the previous one stays in the version list). If those files don't change, deploys leave the volume alone.
- Uploaded IFC files are deleted after conversion; only the converted model (about 3 MB each) is kept.
- The conversion needs about 2 GB of memory for a 250 MB IFC. If it fails with an out-of-memory message, raise the service's memory limit in Railway.
- If no volume is attached, the server logs a warning and keeps data in `./storage`, which is lost on redeploy.

## Run locally

```
npm start
```

Open http://localhost:3000. Node 18+; IFC uploads also need Python 3 with numpy. Set `UPLOAD_KEY` to enable saving and `DATA_DIR` to choose the storage folder.

## Rebuilding the bundled data by hand

```
pip install numpy openpyxl
python tools/build_data.py MODEL.ifc TRACKER.xlsx
```

Writes `public/data/`. Commit and push to make it the current version on the next deploy.

## Server API

| Method | Path | |
|---|---|---|
| GET | `/api/tracker` | Current tracker `{rows, info}` |
| POST | `/api/tracker` | Save `{rows, filename}`; header `x-upload-key` |
| GET | `/api/history` | Tracker versions |
| POST | `/api/history/<id>/restore` | Make a tracker version current; header `x-upload-key` |
| GET | `/api/model` | Current model info |
| POST | `/api/model` | Upload an IFC (raw body); headers `x-upload-key`, `x-filename` |
| GET | `/api/model/job` | Progress of the latest conversion |
| GET | `/api/model/history` | Model versions |
| POST | `/api/model/<id>/restore` | Make a model version current; header `x-upload-key` |
| GET | `/api/status` | Whether saving is on and storage is persistent |
| GET | `/health` | Health check |

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard (3D viewer written in plain WebGL, no external libraries) |
| `public/data/` | Model and tracker that ship with the code |
| `server.js` | Web server: serves the page, stores trackers and models on the volume, runs IFC conversions |
| `Dockerfile` | Railway build: Node + Python + numpy |
| `tools/build_model.py` | IFC → model files (used by the server for uploads) |
| `tools/build_data.py` | IFC + tracker Excel → `public/data/` |
| `tools/parse_props.py`, `tools/geom.py` | IFC property and geometry readers |
