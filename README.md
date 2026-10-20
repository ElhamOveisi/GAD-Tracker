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
2. Railway detects Node and runs `npm start`. The server listens on Railway's `PORT`.
3. Under **Settings → Networking**, click **Generate Domain** to get a public URL.

Every push to the main branch redeploys automatically.

## Updating the data

### New tracker only
Either use **Load new tracker** on the page (only lasts in that browser), or rebuild the data files:

```
pip install numpy openpyxl
python tools/build_data.py MODEL.ifc TRACKER.xlsx
```

### New model export
Export the IFC from Revit with Revit property sets included (so `STJV_4D_Activity ID` comes through), then run the same command. It takes about a minute for a ~250 MB IFC. Commit the changed files in `public/data/` and push. Railway redeploys.

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard (3D viewer written in plain WebGL, no external libraries) |
| `public/data/model.bin` | Panel geometry converted from the IFC (gzip-compressed) |
| `public/data/meta.json` | Activity ID, lift, GUID, Revit area and type per model panel |
| `public/data/tracker.json` | Tracker rows |
| `public/data/config.json` | Text shown under the title |
| `server.js` | Small static web server for Railway |
| `tools/` | Python scripts that convert the IFC and tracker into `public/data` |
