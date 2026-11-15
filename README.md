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
3. `npm start` serves the API on `PORT` (default 3000). `npm test` runs the unit tests (no database required).

**Write protection:** set `ADMIN_TOKEN` to require `Authorization: Bearer <token>` on playlist writes and manual lyrics saves. While it is empty, those endpoints remain open, as before. The built-in "Add / Paste Lyrics" button does not send a token yet, so enabling the token disables that button until the client is updated.

**Safe defaults:** the Airflow DAG is created paused and the pipeline must stay paused until explicitly authorized; the API makes no artwork lookups.

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
