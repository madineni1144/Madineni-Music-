# Madineni Music

Personal music app with an Ubuntu-hosted API, PostgreSQL catalog, web frontend, and import pipelines.

## Frontend
`frontend/` — main music website and playback controls.

## Frontend Demo
`frontend-demo/` — alternate designs and prototypes.

## Backend
`backend/` — Node.js API and server code. The existing service runs on port 3000.

### Backend setup and tests
1. `cd backend && npm install`
2. Copy `.env.example` to `/opt/musicapp/app/config/.env` (or point `ENV_FILE` at it) and fill in the database settings.
3. `npm start` serves the API on `PORT` (default 3000). `npm test` runs the test suite (no database needed; route tests need the npm dependencies and are reported as skipped without them).

**Write authentication (fail-closed).** Playlist writes and manual lyrics saves require `Authorization: Bearer <token>`, where the token is `MUSICAPP_WRITE_TOKEN` (at least 32 characters; `openssl rand -hex 32`). If it is missing or too short, those routes return `503 WRITE_AUTH_UNAVAILABLE` and nothing is writable; reads and playback are unaffected. Writes are refused over plain HTTP (`403 HTTPS_REQUIRED`) unless `MUSICAPP_REQUIRE_HTTPS=false`. There is no token in the frontend: the lyrics editor asks an authorized user to type it, keeps it in memory only, and discards it on reload or when the server rejects it. The earlier unreleased `ADMIN_TOKEN` name was never deployed and is not read.

**CORS.** Only origins listed in `CORS_ORIGINS` get cross-origin access; leave it empty for same-origin use. CORS does not replace authentication.

**Song pagination.** `GET /api/songs` returns at most `MUSICAPP_MAX_PAGE_SIZE` rows (default 500; default page 100) ordered by id. Clients request `?limit=&offset=` pages until an empty page. Any other caller that relied on getting the whole library in one response must page the same way.

**Diagnostics.** `GET /api/health` returns only `{success, status}`; `/api/db-test` returns only `{connected}`.

### Pipeline settings
Defaults are unchanged; override with `MUSICAPP_MUSIC_ROOT`, `MUSICAPP_STAGING_DIR`, `MUSICAPP_REPORT_DIR`, `MUSICAPP_DB_ENV_FILE`, `MUSICAPP_EMAIL_ENV`, `GOOGLE_DRIVE_TOKEN_FILE`, `GOOGLE_OAUTH_CLIENT_FILE`. The Airflow DAG is created paused and must stay paused until explicitly authorized; no artwork lookups are made. Tests: `PYTHONPATH=. python3 -m unittest discover -s audio_pipeline/tests`.

## iOS App
`ios/` — reserved for the Xcode app; upload its source separately.

## Audio Pipeline
`audio_pipeline/` — ingestion, validation, metadata normalization, storage, and reports.

## Airflow
`airflow/` — DAGs, scheduling, and Docker configuration.

## Database
`database/` — reviewed schema and migrations only. Live database contents remain on the server.

## Maintenance Scripts
`scripts/` — album organization, artwork retrieval, deduplication, and lyrics setup.

## Documentation
`docs/` — installation, deployment, Cloudflare, and troubleshooting.

## Archive
`archive/` — historical script versions and retired DAGs, after review for credentials.

## Server Data
Songs: `/opt/musicapp/music/Songs`

Artwork: `/opt/musicapp/covers`

Database: `music_app`

Audio, artwork, database dumps, passwords, and tunnel credentials are excluded from this public repository. GitHub stores the application source; Ubuntu continues hosting the service and data.

## Migration Status
Repository documentation prepared. Ubuntu source files and the iOS project have not yet been uploaded. Review source for hard-coded credentials before committing.
