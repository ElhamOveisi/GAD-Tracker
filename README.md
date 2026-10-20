# GAD Glass Works Tracker

A web dashboard for the GAD glass works. It shows the glass model in 3D, coloured by each panel's status from the tracker, with:

- **3D Model**: filter by group, sub group, status or Activity ID. Click a panel to see its details; double-click to zoom to it.
- **Summary**: where the panels are, as percentages at each status by group and sub group (by panel count or m²).
- **Data Checks**: panels in the model but not the tracker (and the reverse), duplicates, status spelling and area differences.

Model panels are linked to tracker rows by `STJV_4D_Activity ID`. Lift panels share IDs across lifts, so they are linked by lift (`STJV_1D_Element_Notes` P1–P4) plus Activity ID.

## Run locally

```
npm start
```

Then open http://localhost:3000. No packages to install (Node 18+).

## Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo** → pick this repo.
2. **Add a volume:** right-click the service (or Settings) → **Attach Volume**, mount path **`/data`**.
   Railway then sets `RAILWAY_VOLUME_MOUNT_PATH` and the server stores the tracker there automatically.
3. **Variables** → add `UPLOAD_KEY` = a password of your choice. People need it to save a new tracker from the page.
   Without it, saving is switched off (viewing still works).
4. **Settings → Networking → Generate Domain** for the public link.

Every push to `main` redeploys automatically. Data on the volume is kept across redeploys.

## How the data is kept

| What | Where | Survives redeploy |
|---|---|---|
| Current tracker | volume: `/data/tracker.json` | Yes |
| Every previous tracker version | volume: `/data/history/` | Yes, never deleted |
| Model geometry | `public/data/` in this repo | Yes (it's in the code) |

- **Load new tracker → Save for everyone** (with the upload password) replaces the tracker for all viewers. The previous version goes to history.
- **Data Checks → Tracker versions** lists every saved version, with **Restore** for each.
- On the very first start with an empty volume, the tracker in `public/data/tracker.json` is copied to the volume.
- If you later push a changed `public/data/tracker.json` through GitHub, it's applied on deploy as a new version (the volume's current one is moved to history first). If you don't change that file, deploys leave the volume's tracker alone.
- If no volume is attached, the server logs a warning and keeps data in `./storage`, which is lost on redeploy.

### Server API

| Method | Path | |
|---|---|---|
| GET | `/api/tracker` | Current tracker `{rows, info}` |
| POST | `/api/tracker` | Save `{rows, filename}`; header `x-upload-key` |
| GET | `/api/history` | List of saved versions |
| POST | `/api/history/<id>/restore` | Make a saved version current; header `x-upload-key` |
| GET | `/health` | Health check |

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard (3D viewer written in plain WebGL, no external libraries) |
| `public/data/model.bin` | Panel geometry converted from the IFC (gzip-compressed) |
| `public/data/meta.json` | Activity ID, lift, GUID, Revit area and type per model panel |
| `public/data/tracker.json` | Tracker rows |
| `public/data/config.json` | Text shown under the title |
| `server.js` | Web server for Railway: serves the page and stores trackers on the volume |
| `tools/` | Python scripts that convert the IFC and tracker into `public/data` |
