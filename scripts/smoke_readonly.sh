#!/usr/bin/env bash
# Isolated post-deploy smoke test. It can NOT create or change production data:
#   * never sends credentials (no token is read, accepted or sent)
#   * only GETs, plus a few inert write probes that the hardened server must reject
#     BEFORE touching the database. Probe bodies are deliberately invalid
#     (empty playlist name, song id 0, non-numeric playlist id), so even a
#     pre-hardening server would answer 400 and write nothing.
#   * refuses to send any non-GET request unless /api/health already has the hardened
#     shape, i.e. the target is the new code.
# Usage: scripts/smoke_readonly.sh https://music.example.com
# Authenticated write checks (playlist create/delete, lyrics save) are NOT done here:
# run those only against a local scratch instance with a scratch database.
set -uo pipefail
BASE="${1:?usage: $0 <base-url, no trailing slash>}"
BASE="${BASE%/}"
fail=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }
code() { curl -sS -o /dev/null -m 15 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
body() { curl -sS -m 15 "$@" 2>/dev/null; }

health="$(body "$BASE/api/health")"
if [ "$health" = '{"success":true,"status":"ok"}' ]; then ok "health is minimal ($health)"; else
  bad "health is not the hardened minimal shape: ${health:0:120}"
  echo "ABORT: target does not look like the hardened build; sending no write probes." >&2
  exit 1
fi

db="$(body "$BASE/api/db-test")"
[ "$db" = '{"connected":true}' ] && ok "db-test is minimal" || bad "db-test shape: ${db:0:120}"

n="$(body "$BASE/api/songs?limit=2&offset=0" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo -1)"
[ "$n" = "2" ] && ok "songs limit=2 returns 2 rows" || bad "songs limit=2 returned: $n"

n="$(body "$BASE/api/songs?limit=999999" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo -1)"
if [ "$n" -ge 0 ] && [ "$n" -le 500 ] 2>/dev/null; then ok "songs limit=999999 capped (<=500, got $n)"; else bad "songs limit=999999 returned: $n"; fi

hdr="$(curl -sS -m 15 -D - -o /dev/null -H 'Origin: https://evil.example' "$BASE/api/health" 2>/dev/null | tr -d '\r' | grep -i '^access-control-allow-origin' || true)"
[ -z "$hdr" ] && ok "no CORS header for a foreign origin" || bad "CORS header for foreign origin: $hdr"

reject() { # name expected-codes... -- curl args
  local name="$1"; shift
  local c; c="$(code "$@")"
  case "$c" in 401|403|503) ok "$name rejected ($c)";; *) bad "$name returned $c (expected 401/403/503)";; esac
}
JSON='Content-Type: application/json'
reject "POST /api/playlists (no auth)"            -X POST   -H "$JSON" -d '{"name":""}' "$BASE/api/playlists"
reject "POST /api/playlists/0/songs (no auth)"    -X POST   -H "$JSON" -d '{"song_id":0}' "$BASE/api/playlists/0/songs"
reject "DELETE /api/playlists/abc (no auth)"      -X DELETE "$BASE/api/playlists/abc"
reject "DELETE /api/playlists/0/songs/0 (no auth)" -X DELETE "$BASE/api/playlists/0/songs/0"
reject "POST /api/songs/0/lyrics (no auth)"       -X POST   -H "$JSON" -d '{}' "$BASE/api/songs/0/lyrics"
reject "GET lyrics ?refresh=1 (no auth)"          "$BASE/api/songs/1/lyrics?refresh=1"
reject "forged proxy headers + bad token"         -X POST -H "$JSON" -H 'Authorization: Bearer not-a-real-token' \
  -H 'X-Forwarded-Proto: https' -H 'CF-Visitor: {"scheme":"https"}' -d '{"name":""}' "$BASE/api/playlists"

[ "$fail" = 0 ] && echo "SMOKE PASSED (read-only)" || echo "SMOKE FAILED"
exit "$fail"
