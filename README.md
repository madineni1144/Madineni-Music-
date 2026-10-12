# Madineni Music

Personal music app with an Ubuntu-hosted API, PostgreSQL catalog, web frontend, and import pipelines.

## Frontend
`frontend/` — main music website and playback controls.

## Frontend Demo
`frontend-demo/` — alternate designs and prototypes.

## Backend
`backend/` — Node.js API and server code. The existing service runs on port 3000.

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
Backend, web players, lyrics integration, and audio pipeline source are now tracked. The native iOS project still needs to be added separately.

See [the compatible update guide](docs/compatible-update.md) for the reliability changes, verification steps, backup and rollback procedure. Keep bounded pagination disabled until the native iOS client has been checked.
