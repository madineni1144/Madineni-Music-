# Write-token requirement: client impact and credential handling

Scope: what changes for clients when the API starts requiring `MUSICAPP_WRITE_TOKEN`, and
how the credential is kept out of source code and logs. Nothing here has been deployed.

Legend used throughout: **VERIFIED** = observed in this repository (code read, and/or a test that ran
in CI on the PR head); **UNVERIFIED** = depends on something not in this repository (the live server,
Cloudflare/nginx, the production database, or an app whose source is not here).

## 1. What the server now does (VERIFIED by `routes.test.js` and `integration/db-writes.test.js`)

| Situation | Response | Database changed? |
|---|---|---|
| `MUSICAPP_WRITE_TOKEN` unset or shorter than 32 characters | `503 WRITE_AUTH_UNAVAILABLE` | no |
| Request not provably HTTPS (and `MUSICAPP_REQUIRE_HTTPS` not `false`) | `403 HTTPS_REQUIRED` | no |
| Missing / wrong token, wrong scheme, token in query string or body | `401 AUTH_REQUIRED` | no |
| Repeated failures from one client / globally | `429` for the failing requests (see DEPLOYMENT.md "Client-identity limits") | no |
| Correct `Authorization: Bearer <token>` over HTTPS | normal handling | yes |

The routes that need the token: `POST /api/playlists`, `POST /api/playlists/:id/songs`,
`DELETE /api/playlists/:id/songs/:songId`, `DELETE /api/playlists/:id`, `POST /api/songs/:id/lyrics`,
and `GET /api/songs/:id/lyrics?refresh=1` (explicit provider re-lookup). Plain reads, search and
playback never need it.

## 2. Which clients need an update

| Client | Write flows it has | Status |
|---|---|---|
| Web lyrics editor and "search again" (`backend/lyrics-player.js`, served at `/api/lyrics/player.js` and loaded by `frontend/index.html` and `frontend-demo/*`) | manual lyrics save, explicit refresh | **VERIFIED updated**: prompts for the token, keeps it in a closure variable only, sends it in the `Authorization` header, refuses to send it over plain HTTP (except localhost), clears it on 401, shows specific messages for 401/403/429/503. |
| Web pages `frontend/index.html`, `frontend/aura-neon-music-app.html`, `frontend-demo/*` | none | **VERIFIED**: the only playlist call is `GET /api/playlists`. There is no playlist create/add/remove/delete UI in this repository, so no page needs a playlist-write change. |
| iOS app | unknown | **UNVERIFIED**: `README.md` says `ios/` is reserved and its source has not been uploaded. If the app calls any route in section 1 it will start receiving 503/401/403 after deployment. It must be inspected before deployment (see section 5). |
| Any other script, shortcut or integration that calls those routes | unknown | **UNVERIFIED**: nothing in the repository lists them. Check the nginx/Cloudflare access logs for `POST`/`DELETE` to `/api/playlists*` and `/api/songs/*/lyrics` before deploying. |

### What an iOS (or any native) client must do

1. Collect the token from the person at use time (a secure text field). Do not bake it into the
   binary, an asset, a plist or a configuration profile.
2. Keep it in memory for the session, or in the Keychain only if the product decision is to persist it
   (not decided; the web client deliberately does not persist it).
3. Send it only as `Authorization: Bearer <token>` over `https://`. Never in a URL or request body.
4. Handle the new responses: 401 (ask again, discard the stored value), 403 `HTTPS_REQUIRED`,
   429 (honour `Retry-After`), 503 `WRITE_AUTH_UNAVAILABLE` (writes disabled server-side).
5. Never log request headers or the token (App Transport Security already requires HTTPS).

## 3. How the credential stays out of source code and logs

| Control | Evidence | Status |
|---|---|---|
| The token only ever comes from the process environment (`MUSICAPP_WRITE_TOKEN`) | `backend/config.js`; `.env.example` lists the name with an empty value; `.env` and `.env.*` are git-ignored | **VERIFIED** (repository scan found no token value in any tracked file; `git grep` for bearer/token literals outside tests returned nothing) |
| Retired name `ADMIN_TOKEN` is not read | `write-routes.test.js` | **VERIFIED** |
| Token never in frontend code, HTML or URLs | `lyrics-player.js` reads it from a typed prompt; `canSendToken()` blocks plain HTTP; header-only | **VERIFIED** by code reading (no browser test exists) |
| Responses never echo the token | `routes.test.js`, `integration/db-writes.test.js` | **VERIFIED** (CI) |
| Server log output never contains a submitted or valid token, including during a forced database error | `integration/db-writes.test.js` "the write token never appears in server log output..." captures `console.*` | **VERIFIED** for application logs (CI) |
| Database error text is not returned to clients in production | `integration/db-writes.test.js` atomicity test | **VERIFIED** (CI) |
| nginx / Cloudflare access logs do not record `Authorization` | standard nginx `log_format` omits request headers, but the live format is unknown | **UNVERIFIED** (server configuration) |
| Query-string tokens are impossible | server ignores them and answers 401 (tested), so no client has a reason to send one; any that did would appear in nginx logs | **VERIFIED** server side; log content **UNVERIFIED** |
| Where the live process gets its environment (systemd unit, `.env` path, permissions) | `DEPLOYMENT.md` step 0 asks the operator to look; this repository cannot | **UNVERIFIED** |
| Token strength | length >= 32 enforced; entropy is the operator's responsibility (`openssl rand -hex 32`) | length **VERIFIED**, generation **UNVERIFIED** |

Rotation: change `MUSICAPP_WRITE_TOKEN` and restart the service; every typed-in token becomes invalid
(clients get 401 and re-prompt). There is no per-user token; anyone who knows it can write.

## 4. Integration test evidence (disposable PostgreSQL, synthetic rows)

`backend/test/integration/db-writes.test.js` runs the real Express app and `pg` driver against a
PostgreSQL 16 service container created for the CI job. Each test creates its own schema and drops it.
A guard (`test/helpers/disposable-db.js`, unit-tested in `test/disposable-db-guard.test.js`) refuses any
host other than loopback and any database not named `musicapp_test*`, without echoing the URL.

It proves: unauthorised writes (no/wrong token, Basic scheme, token in query or body, plain HTTP,
unconfigured server) leave every table unchanged; authorised create/add/remove/delete and lyrics
insert-then-update persist; one playlist's operation never changes another playlist's links, the songs
table or other songs' lyrics; playlist delete is atomic (a forced failure rolls back the link delete and
the pooled connection is released); 20 concurrent identical adds create one link.

### What the integration test does NOT prove

The repository has **no migration or schema file for the core tables** (`songs`, `artists`, `albums`,
`playlists`, `playlist_songs`); `.gitignore` anticipates `database/schema.sql` but none is committed. The
test schema (`test/fixtures/db-test-schema.sql`) is therefore **inferred from the SQL the API runs** and
may differ from production. The route code depends on three properties; confirm them on the real
database with this **read-only** catalogue query (it changes nothing; run it only after approval):

```sql
SELECT conrelid::regclass AS table_name, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('playlist_songs'::regclass, 'playlists'::regclass)
ORDER BY 1, 2;
```

Expected: a PRIMARY KEY or UNIQUE on `(playlist_id, song_id)` (needed for `ON CONFLICT DO NOTHING` to
dedupe), FOREIGN KEYs from `playlist_songs` to `playlists` and `songs` (needed for `23503` to become a
404), and no `ON DELETE CASCADE` surprises (the delete already removes links first, so cascade is
harmless, but a missing FK would let orphan links form). If the production constraints differ, the
integration test passing says nothing about production behaviour.

Also not covered: the live PostgreSQL version and role privileges (a write route needs INSERT/DELETE on
the playlist tables and INSERT/UPDATE on `madineni_song_lyrics`; `ensureSchema` also runs `CREATE TABLE
IF NOT EXISTS` at startup, so the role needs CREATE on the schema or the table must pre-exist), and
anything behind nginx/Cloudflare.

## 5. Pre-deployment checklist for this requirement (operator, after approval)

1. Read-only: confirm the constraints above and the DB role's privileges.
2. Read-only: search the last 30 days of nginx/Cloudflare logs for write requests to the routes in
   section 1; list the user agents. Anything not the web editor is an unlisted client.
3. Obtain the iOS source (or confirm it never writes) before enabling the token.
4. Generate the token, place it in the service environment (not in git), and confirm it is absent
   from `systemctl show` output shared in tickets.
5. Confirm the live `X-Forwarded-Proto`/`CF-Visitor` path (DEPLOYMENT.md section 3), otherwise every
   authorised write answers `403 HTTPS_REQUIRED`.
