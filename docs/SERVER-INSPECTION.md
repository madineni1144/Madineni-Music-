# Read-only server inspection

Status: **prepared, not yet run.** Nothing in this repository has verified the live server. Until you send back
the output of these steps, every statement about the live directory, running version, proxy, database
constraints and client behaviour is unverified.

The three scripts only read. They do not deploy, restart, edit configuration, run migrations, write to the
database, call any provider or touch ingestion/artwork verification.

| Script | Reads | Never does |
|---|---|---|
| `scripts/run_inspection.sh` | orchestrates the three below with explicit checks at every stage | print reports, environment values or credentials; change anything on the server |
| `scripts/inspect_live_server.sh` | systemd unit properties, process cwd, config variable **names** (presence only; a short allow-list of non-secret settings shown), nginx/cloudflared config lines, sha256 of app files | print secret values or command-line arguments, run `systemctl` mutations, touch the git index, use the network |
| `scripts/inspect_live_db.sql` | PostgreSQL catalogues and the connecting role's privileges, inside `BEGIN READ ONLY` | read application rows, count rows, write anything |
| `scripts/inspect_access_logs.sh` | the access-log files you name | print IPs, query strings, tokens, user agents or raw lines |

Do not use the earlier version of `inspect_live_server.sh` (commit `0e37cf1`): it could print `--token`
values, a quoted `DATABASE_URL` password and unrelated environment-file lines.

## 1. Obtain and verify the four files (live checkout untouched)

Run on the server. The runner needs the hashes, so create `SHA256SUMS` from the values given in the review
message for the pinned commit; do not generate them from the downloaded files.

```bash
SHA=<PINNED_COMMIT_SHA>
D=$(mktemp -d /tmp/inspect.XXXXXX) && cd "$D" || exit 1
for f in run_inspection.sh inspect_live_server.sh inspect_access_logs.sh inspect_live_db.sql; do
  curl -fsSL -o "$f" "https://raw.githubusercontent.com/madineni1144/Madineni-Music-/$SHA/scripts/$f" || { echo "DOWNLOAD FAILED: $f"; exit 1; }
done
# paste the four "hash  filename" lines from the review message into SHA256SUMS, then:
sha256sum -c SHA256SUMS || { echo "CHECKSUM FAILED - stop"; exit 1; }
less run_inspection.sh        # read it before running
```

## 2. Run the runner

```bash
bash run_inspection.sh                                   # lists candidate units only; picks nothing
bash run_inspection.sh --service <exact>.service [--log-dir /var/log/nginx]
```

What it does, in order, stopping with a short sanitised error at the first failure (exit codes 2 args/checksum,
3 service, 4 environment access, 5 connection policy, 6 workdir, 7 server report, 8 database, 9 logs):

1. Re-checks `sha256sum -c`.
2. Verifies the exact unit is loaded, active, running, with a nonzero MainPID that is a live process.
3. Uses `sudo` for a small helper that opens `/proc/<pid>/environ` itself and emits only non-secret settings
   (`DB_HOST/PORT/NAME/USER`, the driver's `PG*` fallbacks, `PGSSLMODE`, `PGSSLROOTCERT`; `DATABASE_URL` is parsed inside
   the helper and only host/port/database/role/sslmode leave it). The environment is never printed or sourced.
   The checked-in `server.js` reads `DB_*` only, sets no TLS option and does not read `DATABASE_URL`; the runner
   mirrors that and reports the policy it derived. It refuses to guess: missing host/name/role, `PGSERVICE`, an
   unparseable URL, or `verify-*` without a readable root certificate all stop the run.
4. Runs the server report, then one `psql` session (read-only, 5 s statement and 1 s lock timeouts) using the
   service's own role, host, port and sslmode. The password is never passed by the runner; `psql` prompts or uses
   your `.pgpass`. The same session's `pg_stat_ssl` row is in `db-report.txt`.
5. Finds the access logs with null-delimited, quoted filenames, oldest first, and summarises them.
6. Prints only the **names** of report files that match a secret-like pattern. This is a supplementary aid, not
   proof; review every report yourself before sending anything.

Reports stay in `/tmp/inspect-reports.XXXXXX` (mode 700) and are never printed. `db-errors.txt` and
`logs-errors.txt` are for you only: do not send them.

## 3. Client compatibility

**iOS source:** not available in this repository or session. If you have the Xcode project, search it for
`URLRequest`, `httpMethod`, `"PUT"`, `"PATCH"`, `"DELETE"`, `/api/playlists`, `refresh=1`, `limit=` and
`offset=`; the hardened server needs a bearer token on every write and returns only the default page (100)
when `limit` is absent. Until then use the logs.

**Logs:** the runner already summarises `access.log*` under `--log-dir` (quoted, null-delimited, oldest first). Optional
coarse client classes (apple-native / browser / script; agents are never printed), for one file:

```bash
CLIENT_CLASS=1 bash inspect_access_logs.sh "/var/log/nginx/access.log" > logs-report-classes.txt
```

It lists every method (including PUT and PATCH), aggregates non-read requests by method + normalised path +
status, counts lyrics `refresh=1` requests, buckets `GET /api/songs` by `limit` (absent / 1-100 / 101-500 /
>500 / invalid) and whether `offset` is used, and counts requests with credential-like query parameter names.

Limits that matter: **no recent writes does not prove compatibility** (logs rotate, features are used rarely).
Requests with no `limit` get 100 songs after deployment, so a client that never paginates will see only the
first page. Cloudflare edge logs are not on the server. If the app logs elsewhere (journald, a different
path), tell me the format instead of running anything else.

## 4. What to send back

Send, as text and after your own skim: `server-report.txt`, `db-report.txt`, `logs-report.txt`, the runner's
stdout, and the `sha256sum -c` output from step 1. Do not send tokens, passwords, environment files, raw log lines or database
rows; none of the three reports should contain them, and if one does, tell me and do not paste it.

## 5. What stays unchanged

Ingestion remains paused, external artwork verification remains disabled, and no live provider is called.
Deployment, restart, configuration changes, migrations and production write tests each need your separate
explicit approval (see `docs/DEPLOYMENT.md`).
