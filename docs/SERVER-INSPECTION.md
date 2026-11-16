# Read-only server inspection

Status: **prepared, not yet run.** Nothing in this repository has verified the live server. Until you send back
the output of these steps, every statement about the live directory, running version, proxy, database
constraints and client behaviour is unverified.

The three scripts only read. They do not deploy, restart, edit configuration, run migrations, write to the
database, call any provider or touch ingestion/artwork verification.

| Script | Reads | Never does |
|---|---|---|
| `scripts/inspect_live_server.sh` | systemd unit properties, process cwd, config variable **names** (presence only; a short allow-list of non-secret settings shown), nginx/cloudflared config lines, sha256 of app files | print secret values or command-line arguments, run `systemctl` mutations, touch the git index, use the network |
| `scripts/inspect_live_db.sql` | PostgreSQL catalogues and the connecting role's privileges, inside `BEGIN READ ONLY` | read application rows, count rows, write anything |
| `scripts/inspect_access_logs.sh` | the access-log files you name | print IPs, query strings, tokens, user agents or raw lines |

Do not use the earlier version of `inspect_live_server.sh` (commit `0e37cf1`): it could print `--token`
values, a quoted `DATABASE_URL` password and unrelated environment-file lines.

## 1. Obtain the scripts without touching the live checkout

Run on the server as any user. This downloads into a new empty directory under `/tmp`; it does not `git pull`,
and does not read or change the live directory.

```bash
SHA=<PINNED_COMMIT_SHA>        # given in the review message; the repo is public
D=$(mktemp -d /tmp/inspect.XXXXXX) && cd "$D"
for f in inspect_live_server.sh inspect_access_logs.sh inspect_live_db.sql; do
  curl -fsSL -o "$f" "https://raw.githubusercontent.com/madineni1144/Madineni-Music-/$SHA/scripts/$f"
done
sha256sum *            # compare with the hashes in the review message
less inspect_live_server.sh   # read it before running
```

If a hash differs, stop and do not run anything.

## 2. Server, proxy and version (no root needed; use `sudo` only if some units are not visible)

```bash
bash inspect_live_server.sh > server-report.txt 2>&1; wc -l server-report.txt; cat server-report.txt
```

It reports: the actual service working directory and running process cwd; whether application files match
release `2b64c13` or `0e37cf1` (sha256) or neither; git HEAD if the directory is a checkout; configuration
variable names as present/absent (`MUSICAPP_WRITE_TOKEN` also "length >= 32: yes/no"); proxy settings relevant
to trusted client IPs and HTTPS (`MUSICAPP_PROXY_MODE`, `MUSICAPP_TRUSTED_PROXIES`, `MUSICAPP_REQUIRE_HTTPS`,
nginx `set_real_ip_from`, `real_ip_header`, `proxy_set_header`, `listen`, cloudflared ingress); listening
sockets (address and process name).

Skim `server-report.txt` yourself before sending it; the script masks long token-like strings, but you are the
final check.

## 3. Database schema and role privileges (catalogue queries only)

Run as the **same role the application uses**, otherwise the privilege answers are not the app's. The password
is prompted for; never put it on the command line.

```bash
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' \
  psql -X -v ON_ERROR_STOP=1 -h <db host> -U <app role> -d <database> -W -f inspect_live_db.sql > db-report.txt
```

It reports role attributes, whether the six tables exist, SELECT/INSERT/UPDATE/DELETE per table, schema
CREATE, sequence USAGE, columns, constraints (the playlist routes need unique `(playlist_id, song_id)` and
foreign keys), indexes, row-level security and triggers. It returns no application data.

## 4. Client compatibility

**iOS source:** not available in this repository or session. If you have the Xcode project, search it for
`URLRequest`, `httpMethod`, `"PUT"`, `"PATCH"`, `"DELETE"`, `/api/playlists`, `refresh=1`, `limit=` and
`offset=`; the hardened server needs a bearer token on every write and returns only the default page (100)
when `limit` is absent. Until then use the logs.

**Logs** (nginx default `access.log` and rotations; list them oldest first):

```bash
ls -l /var/log/nginx/access.log*          # confirm names and the date range they cover
bash inspect_access_logs.sh $(ls -1tr /var/log/nginx/access.log* ) > logs-report.txt
# optional coarse client classes (apple-native / browser / script), never printing agents:
CLIENT_CLASS=1 bash inspect_access_logs.sh /var/log/nginx/access.log > logs-report-classes.txt
```

It lists every method (including PUT and PATCH), aggregates non-read requests by method + normalised path +
status, counts lyrics `refresh=1` requests, buckets `GET /api/songs` by `limit` (absent / 1-100 / 101-500 /
>500 / invalid) and whether `offset` is used, and counts requests with credential-like query parameter names.

Limits that matter: **no recent writes does not prove compatibility** (logs rotate, features are used rarely).
Requests with no `limit` get 100 songs after deployment, so a client that never paginates will see only the
first page. Cloudflare edge logs are not on the server. If the app logs elsewhere (journald, a different
path), tell me the format instead of running anything else.

## 5. What to send back

Send, as text and after your own skim: `server-report.txt`, `db-report.txt`, `logs-report.txt`, plus the
`sha256sum` output from step 1. Do not send tokens, passwords, environment files, raw log lines or database
rows; none of the three reports should contain them, and if one does, tell me and do not paste it.

## 6. What stays unchanged

Ingestion remains paused, external artwork verification remains disabled, and no live provider is called.
Deployment, restart, configuration changes, migrations and production write tests each need your separate
explicit approval (see `docs/DEPLOYMENT.md`).
