# Deployment checklist (review only - nothing here has been run)

Base (what is believed to be live): commit `2b64c13`. Branch under review: `fix/backend-hardening`.
Deployment, merging, Docker image replacement and any production data change require explicit approval.
Ingestion stays **paused** and external artwork verification stays **disabled**. No step below touches
songs, albums, artists, audio, artwork, playlists or lyrics rows.

## 0. The live directory is NOT assumed

The repo's code defaults to `/opt/musicapp/app/...`; earlier information named `/home/rk/Music-App`.
Neither is verified. Server access was not available when this was written (the linked device is a
Windows laptop, not the Ubuntu host), so **step 0 must be done on the server before anything else**:

```
scp scripts/inspect_live_server.sh <server>:/tmp/   # or paste it; it is read-only and prints no secret values
bash /tmp/inspect_live_server.sh | tee /tmp/live-inspection.txt
```

Fill in this table from the output (every row is currently **UNVERIFIED**):

| Item | Value |
|---|---|
| systemd unit name / FragmentPath | UNVERIFIED |
| `User=` | UNVERIFIED |
| `WorkingDirectory=` (= `$APP_DIR`, the live backend directory) | UNVERIFIED |
| `ExecStart=` (node binary + script path) | UNVERIFIED |
| `EnvironmentFile=` path, owner, mode (keys only) | UNVERIFIED |
| Effective `FRONTEND_DIR` / `MUSIC_DIR` / `COVERS_DIR` / `ENV_FILE` / `PORT` | UNVERIFIED |
| Static roots actually served (`FRONTEND_DIR`; `/music`; `/covers`) | UNVERIFIED |
| Where `frontend-demo/*` is served from, if anywhere | UNVERIFIED |
| Proxy: what connects to port 3000 (cloudflared? nginx? tailscale serve?) and its ingress `service:` | UNVERIFIED |
| Cloudflare "Always Use HTTPS" on? | UNVERIFIED |
| Live code identical to `2b64c13`? (sha256 of `server.js`, `madineni-lyrics.cjs`, `lyrics-player.js`, `index.html` vs `git show 2b64c13:<path> \| sha256sum`) | UNVERIFIED |
| Node version (`node -v`; needs >= 18, tested here on 22) | UNVERIFIED |
| Stray `madineni` file present in the static root (served at `/madineni`) | UNVERIFIED |

Stop and re-plan if the working directory or unit differs from what is written below: this document
uses `$APP_DIR` (backend dir) and `$STATIC_ROOT` (effective `FRONTEND_DIR`) as placeholders.
If the live code differs from `2b64c13` (drift), diff it before overwriting anything.

Optional, needs DB credentials, run by you: `psql -d music_app -c '\d songs' -c '\d artists' -c '\d albums'`
to confirm `songs.id` is the primary key (the song-list order relies on it; the lyrics schema's
`REFERENCES songs(id)` already implies a unique constraint).

## 1. Manifest: every changed runtime file and its destination

All paths are relative to the repository root. "Same directory" means the new files sit next to
`server.js`; a missing one makes the service fail at start with `MODULE_NOT_FOUND`.

### Backend -> `$APP_DIR` (same directory as the live `server.js`)

| File | Change |
|---|---|
| `backend/server.js` | modified: `createApp`, guards, CORS allow-list, pagination, minimal health |
| `backend/config.js` | **new** (required by `server.js`) |
| `backend/http-utils.js` | **new** |
| `backend/proxy.js` | **new** |
| `backend/rate-limit.js` | **new** |
| `backend/playlist-store.js` | **new** |
| `backend/songs-query.js` | **new** |
| `backend/madineni-lyrics.cjs` | modified: guarded POST, guarded `?refresh=1`, no error leakage |
| `backend/lyrics-player.js` | modified: token prompt (served by the API at `/api/lyrics/player.js`) |
| `backend/package.json` | modified: `test` scripts, `engines` only. **No new runtime dependencies**; `package-lock.json` unchanged; no `npm install` needed on the server |

### Frontend pages -> `$STATIC_ROOT` (effective `FRONTEND_DIR`)

| File | Change |
|---|---|
| `frontend/index.html` | paged song loading (`apiAllSongs`), visible warning on failure |
| `frontend/aura-neon-music-app.html` | same |

### Demo pages -> destination UNVERIFIED (do not copy until step 0 shows where they are served)

| File | Change |
|---|---|
| `frontend-demo/index.html` | paged song loading (`fetchAllSongs`); also loads `/api/lyrics/player.js` |
| `frontend-demo/index-real.html` | paged song loading (`fetchAllSongs`) |

The demo pages call `${location.origin}/api/songs`, so they only work when served from the API's own
origin. `frontend-demo/madineni-home/*` is unchanged.

### Audio pipeline -> `$APP_DIR/../audio_pipeline/scripts/` (read-only mount into Airflow) - Phase C, optional, DAG stays paused

`audio_pipeline/scripts/db.py`, `download_incoming.py`, `generate_report.py`, `google_oauth_bootstrap.py`,
`playback_validate.py`, `register_songs.py`, `send_email_summary.py`, `store_audio.py`, `store_audio_v2.py`,
`upload_report.py` - only path constants became environment-overridable; defaults are unchanged. They run
only when the DAG is unpaused, which this change does not do.

### Image build only (nothing deployed) 

`airflow/Dockerfile` - declares the Google client, `psycopg2-binary`, `python-dotenv`. Build under a test
tag and verify (section 5); do **not** retag or replace `music-airflow:3.1.0`.

### Unchanged runtime files (no action; they must stay in place)

`backend/lyrics-core.cjs` (required by `madineni-lyrics.cjs`, must remain beside `server.js`),
`backend/lyrics-backfill.cjs` (manual maintenance script, not started by the service; it writes the lyrics cache table, so do not run it as part of this deployment),
`audio_pipeline/scripts/archive_drive.py`, `audio_pipeline/scripts/normalize_metadata.py`,
`audio_pipeline/scripts/validate_audio.py`, `airflow/dags/music_trending_import.py`, `airflow/docker-compose.yaml`.

### Not deployed (repository only)

`.env.example`, `README.md`, `docs/**`, `scripts/*.sh`, `scripts/redesign_frontend_patch.py`, `.github/**`,
`backend/test/**`, `audio_pipeline/tests/**`. The former `frontend/madineni` was moved to
`scripts/redesign_frontend_patch.py`; if a copy exists in the live static root it is publicly served at
`/madineni` and should be moved out (a delete is a destructive operation - needs your approval).

## 2. Configuration to add (values never go in git, HTML or URLs)

Add to the live service's environment file (path from step 0; keep mode 600):

```
NODE_ENV=production
MUSICAPP_WRITE_TOKEN=<openssl rand -hex 32>      # >= 32 chars, else all writes stay disabled (503)
MUSICAPP_PROXY_MODE=cloudflare                   # only if cloudflared on this host fronts the app; otherwise leave unset
CORS_ORIGINS=https://<public hostname>           # or empty for same-origin only
# optional tuning (defaults shown): MUSICAPP_AUTH_FAIL_MAX=10 MUSICAPP_AUTH_FAIL_WINDOW_SEC=900
#   MUSICAPP_REFRESH_SONG_COOLDOWN_SEC=300 MUSICAPP_REFRESH_PER_CLIENT_HOUR=20 MUSICAPP_REFRESH_OVERALL_HOUR=60
```

If the unit does not already pass the old values, also set `ENV_FILE`, `FRONTEND_DIR`, `MUSIC_DIR`,
`COVERS_DIR` to what step 0 found. Without them the new code reads the hard-coded `/opt/musicapp/...`
defaults, which may not be the live paths.

## 3. Trusted-proxy assumptions (HTTPS enforcement)

The server does **not** use Express "trust proxy". A request counts as HTTPS only if:

1. TLS terminates in the Node process, **or**
2. `MUSICAPP_PROXY_MODE=cloudflare`, **and** the TCP peer is a trusted proxy (default: loopback only, or
   addresses in `MUSICAPP_TRUSTED_PROXIES`), **and** the *rightmost* `X-Forwarded-Proto` value is `https`,
   **and** `CF-Visitor` is JSON with `"scheme":"https"`.

Consequences and assumptions to confirm in step 0:

- The listener binds `0.0.0.0:3000`. LAN (`192.168.x.x`) and Tailscale (`100.x`) clients are not trusted
  peers, so forged headers from them are ignored (tested). They also cannot satisfy HTTPS, so **writes from
  `http://<lan-or-tailscale-ip>:3000` return 403** unless `MUSICAPP_REQUIRE_HTTPS=false`, which also drops
  protection for tunnel traffic. Use the public HTTPS hostname for edits.
- Anything on the host that connects over loopback is trusted to vouch for HTTPS. That is correct for
  `cloudflared` pointing straight at `http://localhost:3000`. If nginx/Caddy/`tailscale serve` also sits on
  loopback and forwards a client-supplied `X-Forwarded-Proto` or `CF-Visitor` unchanged, that hop becomes a
  bypass: it must overwrite both, or be removed from the path.
- With Cloudflare "Always Use HTTPS" on, plain-HTTP visitors are redirected and never reach the origin.
  Cloudflare documents overwriting some client-supplied forwarding headers, but the design above does not
  depend on that; it has **not** been verified against your actual tunnel.
- `CF-Connecting-IP` is used only as the rate-limit key and only from a trusted peer.

### Client-identity limits that remain (read before relying on the lockout)

Verified by `backend/test/client-ip-evasion.test.js` with the production limits (10 failures / 15 min / client, 200 global):
- A direct (non-loopback) client cannot change its lockout key with `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded` or `True-Client-IP`; in `none` mode the headers are ignored even from loopback.
- Remaining limits (not fixed here, no limits were weakened or raised):
  1. In `cloudflare` mode a trusted peer's `CF-Connecting-IP` is believed. The origin must be reachable ONLY through cloudflared/the trusted proxy; any other loopback hop (e.g. nginx) must overwrite/forward Cloudflare's header and never pass a client-supplied one, or an attacker can mint identities.
  2. The key is the exact address, so an attacker with an IPv6 /64 can rotate addresses. Bucketing IPv6 to /64 is a possible follow-up.
  3. The global ceiling only changes the answer to failing requests (429); it deliberately never blocks a correct token, so guessing is bounded by token entropy (>= 32 chars required), not by the limiter.

## 4. Order of deployment (after approval)

Nothing below runs until you approve it, step by step. Before step 1, the read-only server inspection in
`docs/SERVER-INSPECTION.md` must have been run and its output reviewed (live directory, configuration names,
proxy trust, database constraints and privileges, client write/paging usage).

**Phase 1 - isolated candidate tests (production is not touched, not restarted).**
Check out the candidate commit into a NEW directory (not the live checkout), point it at a scratch database
and a separate port, set a throwaway write token, and run `npm test` and `scripts/smoke_readonly.sh` against
`http://127.0.0.1:<scratch port>`. Authenticated write tests belong here, never on production.

**Phase 2 - production deployment (needs explicit approval; each step reversible as in section 7).**
1. **Back up** (code and config only; do not copy music, covers or database): `tar` the live backend dir,
   the static root, and the environment file (mode 600). Record unit name, working dir, `git`/sha256 state.
2. **Frontend first.** New pages work with the old API (it already honours `limit`/`offset`, ordered by id).
3. **Backend**: copy the 9 backend files together, add the section-2 variables, `systemctl restart <unit>`.
4. Watch `journalctl -u <unit> -n 50`: expect `Music app API listening` and **no** `WARNING: MUSICAPP_WRITE_TOKEN`.

**Phase 3 - post-restart production checks (read-only).**
5. Browser on the public HTTPS hostname: song list shows the full library count; play a song; open lyrics
   (reading works with no token).
6. `scripts/smoke_readonly.sh https://<public hostname>` (section 6). It is NOT an isolated test: it runs
   against production. Its GETs are read-only, but its invalid unauthenticated write probes are non-GET
   requests (rejected before the database). Run it only if you approve that explicitly.
7. Authenticated write features (token typed in the browser, in memory only) are not tested on production
   unless you separately and explicitly authorize a production write test.

## 5. Airflow image check (separate tag, no DAG, no integrations)

```
docker build -t music-airflow:3.1.0-test airflow/
bash scripts/verify_airflow_image.sh music-airflow:3.1.0-test
```

The script refuses the production tag, runs with `--network none`, bypasses Airflow's entrypoint (no
scheduler, DAG parsing or API server), mounts no env files, tokens or data, then imports every third-party
module the scripts use, runs `pip check`, and imports every pipeline script. **Status: BLOCKED in the review
environment (no Docker daemon); not executed.** The `airflow-image` CI job runs the same script.
Decide separately whether to retag; the DAG remains paused either way.

## 6. Smoke tests: isolated vs production

`bash scripts/smoke_readonly.sh <base url>` sends no credentials and only: GETs, and write probes with
deliberately invalid bodies that the hardened server rejects before the database. It refuses to send any
non-GET request unless `/api/health` already has the hardened shape. It creates no playlists and changes no
lyrics. Expected: every line `ok`, ending `SMOKE PASSED (read-only)`.
(Its safety logic was exercised against stub servers; it has not been run against your server.)

- **Isolated candidate test (phase 1):** base URL is the scratch instance on a separate port. Safe to run freely.
- **Production check (phase 3):** base URL is the public hostname. Needs your explicit approval because of the
  invalid non-GET probes; read-only GET checks (browser, `curl` of `/api/health` and `/api/songs?limit=5`) do not.

Do not run authenticated write tests (create/delete playlist, save lyrics, refresh) on production without
explicit authorization; if authorized, use a throwaway playlist name and delete only that playlist afterwards.

## 7. Rollback

**Important:** the previous code has **no authentication**. Rolling the backend back to `2b64c13` (or to
whatever was live) re-opens public write access to playlists and manual lyrics, and open lyrics refresh,
through the public tunnel *and* the LAN/Tailscale listener. Two different actions are easy to confuse:

- **Disabling writes** (option A): the NEW code keeps running, only writes stop (503). Reads keep working.
  This is not a return to an earlier release.
- **Restoring an earlier release** (options B/C below): the OLD code runs again. It has no auth, so writes
  stay blocked only if you also apply the write-block patch.

Choose a rollback that keeps writes blocked:

**A. Disable writes by configuration (preferred, seconds, no code change; the release stays the new one).** Keep the new code and remove or blank
`MUSICAPP_WRITE_TOKEN`, then restart. Every write route and `?refresh=1` returns 503; reading, playback,
search and paging keep working. Verify: `smoke_readonly.sh` still passes.

**B. Restore the earlier release, with writes blocked.** Restore the backed-up backend files, then apply
`docs/rollback/block-writes-on-2b64c13.patch` to `server.js` (a short middleware that answers 503 to every
non-GET/HEAD/OPTIONS request and to lyrics refresh). Verified only by `git apply` against `2b64c13` and a
direct test of the middleware; if the live file drifted from `2b64c13`, insert the same middleware by hand
right after `app.use(express.json());`. Restart. Verify by hand (invalid bodies only, nothing can be created):
`curl -i -X POST $BASE/api/playlists -H 'Content-Type: application/json' -d '{"name":""}'` must be `503 WRITES_DISABLED`
(the patched legacy health endpoint still shows the old shape, so `smoke_readonly.sh` will rightly refuse to run).

**C. Edge block (extra layer only).** A Cloudflare WAF rule blocking non-GET requests to `/api/*` covers
tunnel traffic but **not** LAN or Tailscale clients, so it never replaces A or B.

Mixed versions: the new frontend works with the old backend; the **old frontend with the new backend shows
only the first 100 songs** (it sends no `limit`). Roll the frontend back only together with, or after, the
backend; never leave old pages on the new API.

Rolling back files never changes data: the new code adds no tables, columns or rows (the lyrics table is
created by existing startup code, unchanged).

### Metadata investigation modules (development only; NOT part of any deployment yet)

Runtime-adjacent files added on `feat/metadata-investigation`. They are not loaded by `server.js`, need no migration, and write nothing to the database.
`backend/metadata/errors.js`, `http-provider.js`, `musicbrainz.js`, `matcher.js`, `report.js`, `agent-tools.js`, `artwork-mock.js`, `fixtures/index.js`; CLI `scripts/metadata-investigate.js`.
