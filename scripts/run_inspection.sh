#!/usr/bin/env bash
# Operator runner for the READ-ONLY server inspection. Run it from the directory that holds the four
# verified files (run_inspection.sh, inspect_live_server.sh, inspect_access_logs.sh, inspect_live_db.sql).
#
#   bash run_inspection.sh --service <exact unit name> [--log-dir /var/log/nginx]
#
# With no --service it only lists candidate unit names and exits: it never picks one for you.
# It changes nothing on the server, sends no HTTP request, and prints only fixed messages plus non-secret
# transport facts (host, port, database, role, TLS mode). Every stage must succeed; the first failure stops
# the run with a short sanitised message. Reports stay in a private directory and are never printed.
#
# Test-only hooks (a warning is printed if any is set): INSPECT_PROC_ROOT, INSPECT_PRIV, INSPECT_PSQL.
set -uo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || { echo "ERROR: cannot resolve script directory" >&2; exit 1; }
PROC="${INSPECT_PROC_ROOT:-/proc}"
PRIV="${INSPECT_PRIV-sudo}"          # empty string = run the helper unprivileged (tests)
PSQL="${INSPECT_PSQL:-psql}"
SERVICE=""; LOG_DIR="/var/log/nginx"

fail() { echo "ERROR [$1]: $2" >&2; echo "Run stopped. Nothing was changed on the server; no report is complete." >&2; exit "${3:-1}"; }
ok() { echo "ok: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --service) [ "$#" -ge 2 ] || fail args "--service needs a value" 2; SERVICE="$2"; shift 2 ;;
    --log-dir) [ "$#" -ge 2 ] || fail args "--log-dir needs a value" 2; LOG_DIR="$2"; shift 2 ;;
    *) fail args "unknown argument" 2 ;;
  esac
done
if [ -n "${INSPECT_PROC_ROOT:-}${INSPECT_PRIV+x}${INSPECT_PSQL:-}" ]; then echo "WARNING: test hooks are active; this run is not a server inspection" >&2; fi

# ---------------------------------------------------------------------------------------------------- 0. inputs
for f in inspect_live_server.sh inspect_access_logs.sh inspect_live_db.sql; do
  [ -r "$HERE/$f" ] || fail files "required file missing or unreadable: $f" 2
done
if [ -r "$HERE/SHA256SUMS" ]; then
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1) || fail checksum "sha256sum -c failed for the downloaded files" 2
  ok "sha256sum -c (all listed files)"
else
  fail checksum "SHA256SUMS not found next to the scripts; verify before running" 2
fi

# ---------------------------------------------------------------------------------------------------- 1. service
if [ -z "$SERVICE" ]; then
  echo "Candidate units (choose the exact name and re-run with --service):"
  systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -Ei 'music|madineni' || echo "  (none matched)"
  exit 2
fi
[[ "$SERVICE" =~ ^[A-Za-z0-9@._-]+\.service$ ]] || fail service "service name must be the exact unit name ending in .service" 2
PROPS="$(systemctl show "$SERVICE" -p LoadState -p ActiveState -p SubState -p MainPID 2>/dev/null)" || fail service "systemctl could not show that unit" 3
prop() { printf '%s\n' "$PROPS" | sed -n "s/^$1=//p" | head -1; }
[ "$(prop LoadState)" = loaded ]   || fail service "unit is not loaded" 3
[ "$(prop ActiveState)" = active ] || fail service "unit is not active" 3
[ "$(prop SubState)" = running ]   || fail service "unit is not running" 3
PID="$(prop MainPID)"
[[ "$PID" =~ ^[0-9]+$ ]] && [ "$PID" -gt 0 ] || fail service "MainPID is missing or zero" 3
[ -d "$PROC/$PID" ] || fail service "MainPID is not a live process" 3
ok "service $SERVICE is loaded, active, running (MainPID verified)"

# ---------------------------------------------------------------------------------------------------- 2. DB settings
# This helper runs privileged, opens the process environment ITSELF, and prints only whitelisted
# non-secret settings. Passwords, tokens and URL userinfo passwords are never emitted. DATABASE_URL is parsed
# inside the helper and only host/port/database/user/sslmode components leave it.
read -r -d '' HELPER <<'HELPER_EOF'
set -u
ROOT="$1"; PID="$2"
[ -r "$ROOT/$PID/environ" ] || { echo "ERR=environ-unreadable"; exit 0; }
declare -A V
while IFS= read -r -d '' e; do
  k="${e%%=*}"; v="${e#*=}"
  case "$k" in
    DB_HOST|DB_PORT|DB_NAME|DB_USER|PGHOST|PGPORT|PGDATABASE|PGUSER|PGSSLMODE|PGSSLROOTCERT|PGSERVICE|DATABASE_URL) V[$k]="$v" ;;
  esac
done < "$ROOT/$PID/environ"
emit() { local k="$1" v="$2"
  if [[ "$v" =~ ^[A-Za-z0-9._:/@+-]*$ ]] && [ "${#v}" -le 255 ]; then echo "$k=$v"; else echo "$k=<invalid>"; fi; }
for k in DB_HOST DB_PORT DB_NAME DB_USER PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT; do
  [ -n "${V[$k]+x}" ] && emit "$k" "${V[$k]}"
done
[ -n "${V[PGSERVICE]+x}" ] && echo "PGSERVICE=<set>"
if [ -n "${V[DATABASE_URL]+x}" ]; then
  u="${V[DATABASE_URL]}"
  if [[ "$u" =~ ^postgres(ql)?://([^/?#]*)(/([^?#]*))?(\?([^#]*))?$ ]]; then
    auth="${BASH_REMATCH[2]}"; db="${BASH_REMATCH[4]}"; q="${BASH_REMATCH[6]}"
    hp="${auth##*@}"; ui=""; [[ "$auth" == *@* ]] && ui="${auth%@*}"
    user="${ui%%:*}"; host="$hp"; port=""
    if [[ "$hp" =~ ^\[([^]]+)\](:([0-9]+))?$ ]]; then host="${BASH_REMATCH[1]}"; port="${BASH_REMATCH[3]}"
    elif [[ "$hp" =~ ^([^:]*):([0-9]+)$ ]]; then host="${BASH_REMATCH[1]}"; port="${BASH_REMATCH[2]}"; fi
    echo "URL_PRESENT=yes"
    [ -n "$host" ] && emit URL_HOST "$host"; [ -n "$port" ] && emit URL_PORT "$port"
    [ -n "$db" ] && emit URL_NAME "$db"; [ -n "$user" ] && emit URL_USER "$user"
    sm=""; [[ "&$q" =~ \&sslmode=([A-Za-z-]+) ]] && sm="${BASH_REMATCH[1]}"; [ -n "$sm" ] && emit URL_SSLMODE "$sm"
    [[ "&$q" =~ \&(sslrootcert|sslcert|sslkey|host|hostaddr|service)= ]] && echo "URL_EXTRA_PARAMS=<present>"
  else
    echo "URL_PRESENT=unparseable"
  fi
fi
echo "HELPER_DONE=yes"
HELPER_EOF

if [ -n "$PRIV" ]; then
  RAW="$($PRIV bash -c "$HELPER" _ "$PROC" "$PID" 2>/dev/null)" || fail env "privileged read of the service environment failed (permission or sudo error)" 4
else
  RAW="$(bash -c "$HELPER" _ "$PROC" "$PID" 2>/dev/null)" || fail env "reading the service environment failed" 4
fi
printf '%s\n' "$RAW" | grep -q '^ERR=environ-unreadable$' && fail env "the service environment could not be opened" 4
printf '%s\n' "$RAW" | grep -q '^HELPER_DONE=yes$' || fail env "environment helper did not complete" 4
printf '%s\n' "$RAW" | grep -q '=<invalid>$' && fail env "a database setting has an unexpected format; not used" 4
printf '%s\n' "$RAW" | grep -q '^PGSERVICE=' && fail policy "PGSERVICE is set for the service; the connection policy cannot be established from here" 5
printf '%s\n' "$RAW" | grep -q '^URL_PRESENT=unparseable$' && fail policy "DATABASE_URL is present but not parseable; connection policy cannot be established" 5
printf '%s\n' "$RAW" | grep -q '^URL_EXTRA_PARAMS=' && fail policy "DATABASE_URL carries host/cert/service parameters that this runner does not follow" 5
get() { printf '%s\n' "$RAW" | sed -n "s/^$1=//p" | head -1; }

# Same precedence the checked-in app has: explicit DB_* first, then the driver's PG* fallbacks; DATABASE_URL only
# fills what is still missing (the checked-in server.js does not read it; live code may differ).
H="$(get DB_HOST)"; P="$(get DB_PORT)"; N="$(get DB_NAME)"; U="$(get DB_USER)"; SRC=""
[ -z "$H" ] && H="$(get PGHOST)"; [ -z "$P" ] && P="$(get PGPORT)"; [ -z "$N" ] && N="$(get PGDATABASE)"; [ -z "$U" ] && U="$(get PGUSER)"
SSLM="$(get PGSSLMODE)"; SSLSRC="PGSSLMODE in the service environment"
if [ -z "$H$N$U" ] && [ "$(get URL_PRESENT)" = yes ]; then
  H="$(get URL_HOST)"; P="$(get URL_PORT)"; N="$(get URL_NAME)"; U="$(get URL_USER)"; SRC=" (from DATABASE_URL components)"
  [ -z "$SSLM" ] && { SSLM="$(get URL_SSLMODE)"; SSLSRC="sslmode in DATABASE_URL"; }
fi
[ -n "$H" ] || fail policy "database host is not set in the service environment; refusing to guess a host or transport" 5
[ -n "$N" ] || fail policy "database name is not set in the service environment" 5
[ -n "$U" ] || fail policy "database role is not set in the service environment" 5
[[ "$H" =~ ^[A-Za-z0-9._:/-]+$ && "$N" =~ ^[A-Za-z0-9._-]+$ && "$U" =~ ^[A-Za-z0-9._-]+$ ]] || fail policy "a database setting has characters this runner will not pass on" 5
[ -z "$P" ] || [[ "$P" =~ ^[0-9]{1,5}$ ]] || fail policy "database port is not numeric" 5
if [ -z "$SSLM" ]; then
  SSLM="disable"; SSLSRC="the app sets no TLS option, so psql is set to match (not psql's default of prefer)"
fi
case "$SSLM" in disable|allow|prefer|require|verify-ca|verify-full) ;; *) fail policy "unsupported sslmode in the service configuration" 5 ;; esac
ROOTCERT=""
case "$SSLM" in verify-ca|verify-full)
  ROOTCERT="$(get PGSSLROOTCERT)"
  [ -n "$ROOTCERT" ] && [ -r "$ROOTCERT" ] || fail policy "the app requires certificate verification but its root certificate path is missing or unreadable here" 5 ;;
esac
TRANSPORT="tcp"; [[ "$H" == /* ]] && TRANSPORT="unix socket"
ok "connection policy: host=$H port=${P:-<unset: driver default 5432>} database=$N role=$U transport=$TRANSPORT sslmode=$SSLM$SRC; $SSLSRC"

# ---------------------------------------------------------------------------------------------------- 3. working dir
OUT="$(mktemp -d /tmp/inspect-reports.XXXXXX)" || fail workdir "cannot create report directory" 6
chmod 700 "$OUT"
echo "reports (local only, not printed): $OUT"

# ---------------------------------------------------------------------------------------------------- 4. server report
bash "$HERE/inspect_live_server.sh" > "$OUT/server-report.txt" 2>&1 || fail server "server inspection script exited with an error (report kept locally)" 7
grep -q '^### end of server inspection$' "$OUT/server-report.txt" || fail server "server report is incomplete (end marker missing)" 7
ok "server report complete"

# ---------------------------------------------------------------------------------------------------- 5. database report
PSQL_ARGS=(-X -v ON_ERROR_STOP=1 -h "$H" -U "$U" -d "$N" -f "$HERE/inspect_live_db.sql")
[ -z "$P" ] || PSQL_ARGS+=(-p "$P")
ENVV=(PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' PGSSLMODE="$SSLM")
[ -z "$ROOTCERT" ] || ENVV+=(PGSSLROOTCERT="$ROOTCERT")
env -u PGHOST -u PGPORT -u PGDATABASE -u PGUSER -u PGSERVICE -u PGSSLMODE -u PGSSLROOTCERT -u PGSSLCERT -u PGSSLKEY -u PGPASSWORD \
  "${ENVV[@]}" "$PSQL" "${PSQL_ARGS[@]}" > "$OUT/db-report.txt" 2> "$OUT/db-errors.txt" \
  || fail database "database connection or catalogue query failed (details kept locally in db-errors.txt, not shown)" 8
grep -q '^### end of catalogue inspection$' "$OUT/db-report.txt" || fail database "database report is incomplete (end marker missing)" 8
grep -q 'this_session_uses_tls' "$OUT/db-report.txt" || fail database "pg_stat_ssl evidence for the inspection session is missing" 8
grep -q 'read_only_transaction' "$OUT/db-report.txt" && grep -qE '\| on[[:space:]]*$' "$OUT/db-report.txt" || fail database "could not confirm the session was read-only" 8
ok "database report complete (read-only session, pg_stat_ssl recorded from the same session)"

# ---------------------------------------------------------------------------------------------------- 6. logs
[ -d "$LOG_DIR" ] || fail logs "log directory not found" 9
LOGS=()
while IFS= read -r -d '' f; do LOGS+=("$f"); done < <(find "$LOG_DIR" -maxdepth 1 -type f -name 'access.log*' -printf '%T@ %p\0' 2>/dev/null | sort -z -n | cut -z -d' ' -f2-)
[ "${#LOGS[@]}" -gt 0 ] || fail logs "no access.log* files found in the log directory" 9
for f in "${LOGS[@]}"; do [ -r "$f" ] || fail logs "a log file is not readable by this user (re-run as a user that can read it)" 9; done
bash "$HERE/inspect_access_logs.sh" "${LOGS[@]}" > "$OUT/logs-report.txt" 2> "$OUT/logs-errors.txt" || fail logs "log summary failed (details kept locally)" 9
grep -q '^### scope$' "$OUT/logs-report.txt" || fail logs "log report is incomplete" 9
ok "log report complete (${#LOGS[@]} files)"

# ---------------------------------------------------------------------------------------------------- 7. review aid
echo
echo "Automated pattern check (supplementary only; it is NOT proof that a report is free of secrets):"
FLAGGED="$(cd "$OUT" && grep -lEi 'password|passwd|secret|token=|bearer |postgres(ql)?://|BEGIN [A-Z ]*PRIVATE|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_=-]{40,}' ./*.txt 2>/dev/null | sed 's#^\./##' | sort -u | tr '\n' ' ')"
if [ -n "$FLAGGED" ]; then echo "  files matching a pattern, review these first: $FLAGGED"; else echo "  no file matched a pattern"; fi
echo "Review every file in $OUT yourself before sending anything. Do not send db-errors.txt or logs-errors.txt."
echo "RUN COMPLETE: all stages produced their reports. This is a read-only inspection; nothing was changed."
