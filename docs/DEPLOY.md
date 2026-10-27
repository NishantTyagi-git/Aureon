# Deploying Aureon

Aureon is one Python web service (FastAPI) that also serves the website. It needs no database server:
on start-up it creates a SQLite file and loads the real MCX data bundled in `data/seed/`
(2 Jan 2019 – 23 Oct 2026, ~3 seconds). No API keys are required.

Deployed copies run in **read-only mode** (`AUREON_READ_ONLY=true`): visitors can explore, compare and
run tests, but can't upload or collect data. To add data, collect it on your own computer, then
update the seed files (see "Updating the data" below).

## Option 1 — Render (recommended, free tier available)

1. Sign in at <https://render.com> with your GitHub account.
2. Click **New → Blueprint**, choose the `Aureon` repository, and click **Apply**.
   Render reads `render.yaml`, builds the `Dockerfile`, and starts the service.
3. Wait for the first build (about 3–5 minutes). Your app will be at `https://aureon-xxxx.onrender.com`.
4. Every `git push` to `main` redeploys automatically.

Notes for the free plan:

* The service sleeps after 15 minutes without visitors; the next visit takes ~30–60 seconds to wake it.
* The free CPU is slow: the **realistic test** can take 1–3 minutes (10–20 s on a laptop). Quick tests,
  comparisons and opportunity checks stay fast. A paid "Starter" instance removes both limits.
* The disk is temporary. That's fine: the data is reloaded from `data/seed/` on every start. Test
  results are kept in memory and disappear on restart, as they do locally.

Prefer not to use the Blueprint? **New → Web Service → your repo**, choose **Docker** as the runtime,
set the environment variable `AUREON_READ_ONLY=true`, and set the health-check path to `/api/status`.

## Option 2 — any Docker host (Railway, Fly.io, Google Cloud Run, a VPS)

```bash
docker build -t aureon .
docker run -p 8000:8000 aureon
```

Open <http://localhost:8000>. The image listens on the `PORT` variable if the platform sets one,
otherwise 8000.

* **Railway:** New Project → Deploy from GitHub repo. It detects the Dockerfile automatically.
* **Fly.io:** `fly launch` in the repository (accept the Dockerfile), then `fly deploy`.
* **Google Cloud Run:** `gcloud run deploy aureon --source . --allow-unauthenticated`.

## Option 3 — run it on your own machine for others on your network

```bash
.venv\Scripts\python run.py
```

Set `AUREON_HOST=0.0.0.0` in `.env` to accept connections from other computers. Leave read-only off
if you want to keep loading data through the Data sources page.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUREON_READ_ONLY` | `false` (`true` in the Docker image) | Block uploads, imports and collection |
| `PORT` / `AUREON_PORT` | `8000` | Port to listen on (`PORT` is set by most hosts) |
| `AUREON_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Interface to listen on |
| `AUREON_DATA_DIR` | `./data` | Where the database and raw archive are written |
| `AUREON_LOG_LEVEL` | `INFO` | Logging detail |
| `TINYFISH_API_KEY` | — | Optional; only for automated TinyFish collection. Not needed to deploy. Never commit it. |

## Updating the data

1. On your computer, collect new days (Data sources → option 1), and import them as usual.
2. Copy the new collector file into `data/seed/`.
3. Commit and push. Render rebuilds and loads the extra file on start.

## A note on the data

`data/seed/` contains MCX bhavcopy data downloaded from the exchange's public website. If the
repository or the deployment is public, check MCX's terms of use for redistribution; making the GitHub
repository private (Settings → General → Danger Zone → Change visibility) keeps the files out of public
view while Render can still deploy it.
