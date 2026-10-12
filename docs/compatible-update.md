# Compatible reliability update

This branch prepares the architecture report's recommended changes for review.
Creating or pulling the branch does not deploy the Ubuntu service.

## Compatibility decisions

- Keep the existing song-array response and the existing Ubuntu directory defaults.
- Keep unpaginated native requests working by default. All four web players now
  load the complete catalog in pages. Set SONGS_PAGINATION_ENABLED=true only after
  the native iOS client is confirmed to follow pages; this enables a default of
  50 songs and a maximum of 500 per response. The iOS source is not in this repo.
- Apply API request limits independently of audio files, artwork and health
  checks. Seeking remains supported through HTTP Range responses.
- Allow the public music domain and same-host web origins. Native requests
  without an Origin header remain usable. Add additional web origins to
  CORS_ORIGINS as a comma-separated list; an embedded client with Origin null
  needs an explicit entry if that mode is intentionally supported.
- Trust only loopback proxy connections by default, for a local cloudflared
  process. Configure TRUST_PROXY for a different verified proxy topology.
- Enable Helmet headers while leaving CSP and HSTS disabled in this first
  update, because the current players use inline scripts, inline event handlers
  and local HTTP. Cross-origin artwork/audio loading remains permitted.
- Keep audio caching at zero by default. MUSIC_CACHE_MAX_AGE=30d is available
  when files are versioned or do not change at the same URL.
- Preserve environment variables set by systemd. ENV_FILE can select a custom
  backend configuration file; otherwise the existing deployed configuration,
  config/.env and the repository .env are checked in that order.
- Pipeline environment files and directories accept overrides without changing
  their existing Ubuntu defaults. MUSICAPP_ENV_FILE selects the pipeline file.
- Keep the old store_audio_v2 module as a small wrapper around store_audio.
- Move the historical frontend/madineni snippet to
  archive/frontend-redesign-snippet.txt, because it contains mixed Python and
  shell text and should not be served as part of the player.

## Verify before any server update

Install backend dependencies with npm ci --ignore-scripts, then run npm test
from backend/. Tests use a disposable 601-song catalog through pg-mem and a real
local Express HTTP server. FFmpeg generates and decodes a test MP3. No production
songs, passwords, provider calls or database connections are used.

The checks cover full and paginated catalogs, all four browser song loaders,
artwork, CORS, inline-script compatibility, request limits, byte-range seeking,
playlist validation and locally resolved/cached lyrics.

These checks do not validate the live PostgreSQL database, Cloudflare topology,
the native iOS application, remote LRCLIB availability or a rebuilt Airflow image.
Run those checks on the target environment before deployment. Docker and a live
PostgreSQL server are not present in the preparation environment.

## Backup and rollback

Before applying code on Ubuntu:

1. Check the actual systemd ExecStart, WorkingDirectory and frontend directory.
   Compare deployed code with the branch's base commit before overwriting it.
2. Save backend/ (including its current node_modules), frontend/ and
   frontend-demo/ to a timestamped backup. Retain systemd configuration and
   configuration files, and record current song/album counts and a health check.
3. Install and test the proposed backend in a separate staging directory.
   Keep SONGS_PAGINATION_ENABLED=false for the initial update.
4. Copy the reviewed files and production dependencies to the actual service
   directory, restart musicapp.service, and check /api/health, the song count,
   album artwork, playback, seeking and lyrics from the website and phone.
5. If any check fails, restore the backed-up code and node_modules, restart the
   service and repeat the health/playback checks. No data migration is required
   for the application changes.

Rebuild Airflow separately using the repository root as the Docker build context:

    docker build -f airflow/Dockerfile -t music-airflow:3.1.0 .

The Compose build context now points to that root. The image installs the audio
pipeline requirements while keeping the Airflow version fixed to the base image.
The Docker context includes only the Dockerfile and requirements file. Verify
the new image's imports and a paused test DAG before replacing running workers.

## Optional database work

database/migrations/001_search_trigrams.sql contains the suggested search
indexes. It is not run by the application or deployment steps. Run it separately
with a verified PostgreSQL connection, outside a transaction, after checking
extension permissions and free disk space. Concurrent index creation can leave
an invalid index after failure; inspect validity before retrying.

The live database schema has not been exported. Do not create a guessed schema
from the API queries. Export and review the real schema before committing a
database/schema.sql file.

## References

- https://helmet.js.org/
- https://express-rate-limit.mintlify.app/reference/configuration
- https://expressjs.com/en/guide/behind-proxies/
- https://airflow.apache.org/docs/docker-stack/build.html
