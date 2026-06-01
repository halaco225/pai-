# Daily Intel Pipeline — Handoff

## Status
**Partially working.** DBS, SOS, Forgot Clock-Out steps succeed. Fourth Labor, SMG, and HutBot steps fail because Playwright Chromium binary is not present on the Render server.

## Original Problem
Daily Intel dashboard showed `—` for Labor %, OT Hours, Guest Comments, and "NO DATA" for HutBot Routines. The 5am cron pipeline runs but Playwright-based scrapers (Fourth Analytics, SMG, HutBot) all fail with:
```
browserType.launchPersistentContext: Executable doesn't exist at <path>
```

## What's Been Fixed
1. **Multer upload paths** — All 5 routes (`daily.js`, `intel.js`, `pl.js`, `alignment.js`, `recap.js`) now write to `/tmp/uploads` instead of read-only `/uploads`.
2. **Missing `getAcknowledgments` function** — Added to [services/db.js](services/db.js); was causing 500s on Accountability and Weekly Digest tabs.
3. **Labor % never stored** — [services/parsers/fourth-labor-parser.js](services/parsers/fourth-labor-parser.js) now upserts `labor_pct` as a soft indicator.
4. **All area coaches missing in drill-down** — KPI endpoint in [routes/intel.js](routes/intel.js) now seeds `storeMap` from `store_assignments` first.
5. **Pipeline silently dying** — Fixed JSDoc syntax error in [services/browser-launch.js](services/browser-launch.js) (`*/` inside comment closed it prematurely → SyntaxError → entire pipeline crashed on require).
6. **Pipeline observability** — Added per-step DB logging via `logIntelJob()` and `/api/intel/automation/logs` endpoint to inspect runs.
7. **Browser-check endpoint** — `/api/intel/automation/browser-check?token=…` lists what's actually on disk at the configured `PLAYWRIGHT_BROWSERS_PATH`.

## Outstanding Issue: Playwright Browser Not Installing
**Symptoms:** `/api/intel/automation/browser-check` returns `exists: false, dirs: []` — i.e., `PLAYWRIGHT_BROWSERS_PATH` directory is empty on the running server.

**Paths tried (in order):**
| Path | Result |
|------|--------|
| `/opt/render/project/src` | Build install never ran or installed elsewhere |
| `/tmp/ms-playwright` (startup install) | Caused server startup timeout |
| `/opt/render/project/cache/playwright-browsers` | Cache dir not accessible at runtime on Render |
| `/opt/render/project/src/playwright-browsers` (current) | Build command not running install |

**Current config in [render.yaml](render.yaml):**
```yaml
buildCommand: npm install && PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/src/playwright-browsers npx playwright install chromium
envVars:
  - key: PLAYWRIGHT_BROWSERS_PATH
    value: /opt/render/project/src/playwright-browsers
```

**Latest deploy (commit `554271e`):** Moved install into [startup.sh](startup.sh) as a *synchronous* step that runs only if browser is missing. Includes verbose logging (`PWD`, install exit code, `ls -la` of target dir). This will tell us whether the install actually works at startup time.

## Next Steps for Whoever Picks This Up

1. **Wait for commit `554271e` to deploy on Render**, then check Render's runtime logs — look for lines starting with `==>` to see whether `npx playwright install chromium` succeeded at startup.

2. **Check Render dashboard for manual overrides:**
   - Settings → Build Command — if anything is in this field, it overrides `render.yaml`. Clear it so the yaml takes effect.
   - Environment → `PLAYWRIGHT_BROWSERS_PATH` — must be `/opt/render/project/src/playwright-browsers`.

3. **If startup install also fails**, the most likely culprits are:
   - Render's free/starter tier disk quota (Playwright chromium is ~150 MB)
   - Network restriction blocking Playwright CDN download
   - Working directory mismatch (`pwd` log will reveal this)

4. **Once browser is present**, trigger pipeline manually:
   ```
   curl -X POST "https://pai-ayvaz.onrender.com/api/intel/automation/run-batch?token=38b8091924e1f85583454212a9860038"
   ```
   Then GET `/api/intel/automation/logs?token=…` to confirm Fourth, SMG, HutBot all returned `success: true`.

5. **Daily cron** runs at 10:00 UTC (5am CT) via [scripts/intel-cron.js](scripts/intel-cron.js) — once browser issue is fixed, this will populate Daily Intel automatically each morning.

## Key Endpoints (require `INTEL_AUTOMATION_TOKEN`)
- `POST /api/intel/automation/run-batch?token=…` — manually trigger full pipeline
- `GET  /api/intel/automation/logs?token=…` — last ~20 pipeline run results
- `GET  /api/intel/automation/browser-check?token=…` — diagnose Playwright binary path

Token: `38b8091924e1f85583454212a9860038`

## Recent Commits (this session)
```
554271e fix: install Playwright synchronously at startup with verbose logging
af23011 fix: install Playwright at startup in background — build install isn't running
60fa7f1 fix: install Playwright to /src not /cache — cache dir not accessible at runtime
8f337b7 fix: install Playwright to Render cache dir so it survives across deployments
52036b4 debug: add /automation/browser-check endpoint to inspect Playwright binary path
44e852c fix: premature comment close in browser-launch.js broke entire intel pipeline
eab303d debug: add route-level DB logs to diagnose why pipeline never executes
a19c177 fix: log each pipeline step to DB immediately so crashes are diagnosable
e0a85d8 fix: add persistent DB logging to pipeline + /automation/logs endpoint
922801f fix: labor_pct never stored or queried; all area coaches now visible in KPI
```
