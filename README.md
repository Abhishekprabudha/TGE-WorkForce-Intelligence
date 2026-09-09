# TGE Flow — Predictive Operations & Workforce Demo

A self-contained static web prototype designed to demonstrate the TGE predictive operations + workforce management story:

**Predict tomorrow's demand → translate it into workload → compare workforce → recommend actions → simulate → approve → measure value → scale.**

## What is included

- Tomorrow's Depot overview
- Demand forecast with forecast drivers and confidence band
- Workload translator by depot function
- Current roster vs demand-led workforce requirement
- Ranked supervisor action queue
- Human-in-loop Approve / Reject flow
- Before/after simulation and alternative comparison
- Scenario stress testing for demand, absences and linehaul delay
- Value tracker and annualised opportunity view
- One-site → cluster → network scale story
- Guided demo mode that walks through the recommended client presentation click path

All figures are **synthetic demo data** and are clearly labelled in the application.

## Run locally

No build step and no dependencies are required.

Option 1: open `index.html` directly in a modern browser.

Option 2 (recommended):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy on GitHub Pages

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. In GitHub, go to **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select your main branch and `/ (root)`.
6. Save. GitHub will publish the static site.

## Deploy on Netlify / Vercel

Because this is a static app, you can drag the folder into Netlify Drop or import the GitHub repository into Netlify/Vercel with no framework selection or build command.

## Client demo click path

Use **Start guided demo** in the top-right. The built-in sequence is:

1. View Tomorrow
2. Why is demand changing?
3. Translate to Workload
4. Compare Roster
5. Recommend Actions
6. Simulate Impact
7. Stress Test
8. Approve Recommendation
9. Track Value
10. Scale This Pattern

## Where to edit the demo data

The live prototype currently stores its demo values in `app.js` so it can run with zero fetch/server dependencies. A reference JSON file is also included at `data/demo-data.json`.

To personalise for TGE actual data later, replace the synthetic figures in the `data` object near the top of `app.js`.

## Design principles

- TGE-inspired green + dark operational palette, not a sci-fi AI aesthetic
- Dense enough for operators, calm enough for executives
- Every recommendation shows **why / action / cost / service / confidence**
- Human approval is explicit and there is no write-back in pilot mode
- The demo leads with operational decisions, not model terminology
