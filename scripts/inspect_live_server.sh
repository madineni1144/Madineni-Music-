#!/usr/bin/env bash
# READ-ONLY inspection of the live Ubuntu host. Run it ON THE SERVER.
#
# What it never does: write, restart, reload, enable or stop anything; connect to the database; call any
# network service; or modify any file (git is run with --no-optional-locks and a disabled fsmonitor, so
# even the git index is left alone). It never prints a variable value except the allow-listed
# NON-secret ones below, never prints command lines or unit files, and never prints env-file lines.
# Everything it prints is additionally passed through a scrubber (long token-like strings, URL
# credentials and "Bearer ..." values are masked) as a second layer.
#
# Usage:   bash inspect_live_server.sh            (use sudo for process details of another user)
# Test hook: INSPECT_PROC_ROOT overrides /proc (used only by the repository's tests).
set -uo pipefail
umask 077
PROC="${INSPECT_PROC_ROOT:-/proc}"

# --- allow-lists --------------------------------------------------------------------------------
# Values shown (and only if they look harmless: no '@', no quotes, <= 200 characters).
SHOW_VALUE_KEYS="PORT NODE_ENV FRONTEND_DIR MUSIC_DIR COVERS_DIR CORS_ORIGINS MUSICAPP_PROXY_MODE MUSICAPP_TRUSTED_PROXIES MUSICAPP_REQUIRE_HTTPS MUSICAPP_MAX_PAGE_SIZE MUSICAPP_DEFAULT_PAGE_SIZE MUSICAPP_AUTH_FAIL_MAX MUSICAPP_AUTH_FAIL_WINDOW_SEC MUSICAPP_AUTH_FAIL_GLOBAL_MAX MUSICAPP_REFRESH_SONG_COOLDOWN_SEC MUSICAPP_REFRESH_PER_CLIENT_HOUR MUSICAPP_REFRESH_OVERALL_HOUR"
# Reported as present/absent only; values are never printed.
PRESENCE_KEYS="MUSICAPP_WRITE_TOKEN ADMIN_TOKEN DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD"

# --- known file hashes (sha256) of the two reference releases ------------------------------------
KNOWN_HASHES='f8b132b3a5ffdbc5ce5e1e1adf7dc67ea56e620701dee41b31fa2cc3b595768b server.js 2b64c13
e8bc67d9dec5daa4c2f0cb7c5cbb4d535bc35d607f91ab685f084077c681d1ab madineni-lyrics.cjs 2b64c13
c9a0c9cb88795e054a2346556e4fea6dceaea76b01613e2c2edbd17b5200c641 lyrics-player.js 2b64c13
fec893c7a2892de2b331b389bd794abaeeb17e12972d14ad562ec0ee8bcbe382 lyrics-core.cjs 2b64c13
6627998dad2cad52c8f19e147b49ae2effa797031e13e9c35c822e459288f5f5 package.json 2b64c13
97b4f6bd03a9d163a1ce45bc5360b489707e14afafb9cce8451a0b52eaa68456 index.html 2b64c13
2ab27eaba958d75b5b8322ae7510d7787122ae797f7ffc22f87a93d564bc40cc server.js 0e37cf1
51ab6f97a62e003a3962f093d95306e16ea9830b20bcb1cb9a25de3e7c3b0e57 madineni-lyrics.cjs 0e37cf1
5197f312fb6468e08ca81b1e0e63558a032b5d4ab4ae5fe6684b7769bd194e92 lyrics-player.js 0e37cf1
dc6d518465d374dc1efc78462813a965d97749cb8adb988354689838f2ac4eed lyrics-core.cjs 0e37cf1
33d01079c81cca99f177c2ca8a0b665f6a648653cf6d4a86f6c0513f6db5d33d package.json 0e37cf1
8450f47767a740ac84b99090024340111c8626f7b25f6476b67a94350d5a51bc index.html 0e37cf1'

scrub() { # second layer: mask URL credentials, Bearer/Basic values and long token-like words
  awk -v keys="$SHOW_VALUE_KEYS $PRESENCE_KEYS" -v vkeys="$SHOW_VALUE_KEYS" 'BEGIN { nk = split(keys, ka, " "); for (i = 1; i <= nk; i++) ok[ka[i]] = 1
  nv = split(vkeys, va, " "); for (i = 1; i <= nv; i++) okv[va[i]] = 1
  q = sprintf("%c", 39); qre = "^[\"" q "]?[$][a-z0-9_]+[\"" q "]?;?$" }
  {
    lead = ""; if (match($0, /^[ \t]+/)) lead = substr($0, 1, RLENGTH)
    gsub(/:\/\/[^\/@ \t]+@/, "://<userinfo-redacted>@")
    n = split($0, w, /[ \t]+/); out = ""
    for (i = 1; i <= n; i++) {
      t = w[i]; split(t, kv, "="); tk = t; sub(/:$/, "", tk)
      if (i > 1 && tolower(w[i-1]) ~ /^(bearer|basic)$/ && length(t) >= 8) t = "<redacted>"
      else if (length(t) >= 24 && !(kv[1] in okv) && !(tk in ok) && t !~ /^[0-9a-f]+$/ && t !~ /^\/[A-Za-z0-9._\/-]*:?$/ \
               && t !~ /^[A-Za-z_]+=\/[A-Za-z0-9._\/-]*$/ && t !~ qre \
               && t !~ /^[a-z0-9.-]+\.[a-z][a-z]+(:[0-9]+)?;?$/) t = "<long-string-redacted>"
      out = out (i > 1 ? " " : "") t
    }
    print lead out
  }'
}

SAFE_VALUE_RE='^[A-Za-z0-9._:,/ -]*$'
in_list() { case " $2 " in *" $1 "*) return 0;; esac; return 1; }

declare -A VARS SRC
add_var() { # add_var KEY VALUE SOURCE   (kept in memory only)
  VARS["$1"]="$2"; SRC["$1"]="${SRC[$1]:+${SRC[$1]}+}$3"
}
load_env_text() { # reads KEY=VALUE lines on stdin; ignores every other line completely
  local line k v
  while IFS= read -r line; do
    [[ "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    add_var "$k" "$v" "$1"
  done
}

report_vars() {
  local k v
  echo "   configuration (names/presence; values only for allow-listed non-secret keys):"
  for k in $SHOW_VALUE_KEYS; do
    if [ -n "${SRC[$k]+x}" ]; then
      v="${VARS[$k]}"
      if [ "${#v}" -le 200 ] && [[ "$v" =~ $SAFE_VALUE_RE ]]; then echo "     $k=$v   [${SRC[$k]}]"
      else echo "     $k=<set, value not shown>   [${SRC[$k]}]"; fi
    else echo "     $k: absent"; fi
  done
  for k in $PRESENCE_KEYS; do
    if [ -n "${SRC[$k]+x}" ]; then
      if [ "$k" = MUSICAPP_WRITE_TOKEN ]; then
        echo "     $k: present, length>=32: $([ "${#VARS[$k]}" -ge 32 ] && echo yes || echo no)   [${SRC[$k]}]"
      else echo "     $k: present   [${SRC[$k]}]"; fi
    else echo "     $k: absent"; fi
  done
  local other=0
  for k in "${!VARS[@]}"; do in_list "$k" "$SHOW_VALUE_KEYS $PRESENCE_KEYS" || other=$((other + 1)); done
  echo "     other variables set: $other (names not shown)"
}

hash_report() { # hash_report DIR FILE...
  local d="$1" f h lbl; shift
  for f in "$@"; do
    [ -f "$d/$f" ] || { echo "     $f: not found in $d"; continue; }
    h="$(sha256sum "$d/$f" | cut -d' ' -f1)"
    lbl="$(printf '%s\n' "$KNOWN_HASHES" | awk -v h="$h" -v f="$(basename "$f")" '$1==h && $2==f {print $3}' | paste -sd, -)"
    if [ -n "$lbl" ]; then echo "     $f: matches release $lbl"; else echo "     $f: matches NEITHER 2b64c13 NOR 0e37cf1 (live file differs)"; fi
  done
}

inspect_unit() {
  local unit="$1" pid cwd efs ef ex args a n shown
  echo; echo "=== $unit"
  systemctl show "$unit" -p FragmentPath -p User -p WorkingDirectory -p MainPID -p ActiveState 2>/dev/null
  ex="$(systemctl show "$unit" -p ExecStart --value 2>/dev/null | sed -nE 's/.*path=([^ ;]+).*/\1/p' | head -1)"
  echo "ExecStart executable: ${ex:-unknown}   (arguments are never printed)"
  # in-memory only: variables from unit Environment=, EnvironmentFile=, and the live process
  load_env_text unit < <(systemctl show "$unit" -p Environment --value 2>/dev/null | tr ' ' '\n')
  for ef in $(systemctl show "$unit" -p EnvironmentFiles --value 2>/dev/null | tr ' ' '\n' | grep '^/'); do
    echo "EnvironmentFile $ef: $(stat -c 'mode=%a owner=%U:%G' "$ef" 2>/dev/null || echo 'not statable')"
    [ -r "$ef" ] && load_env_text envfile < "$ef"
  done
  pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null)"
  if [ -n "$pid" ] && [ "$pid" != 0 ] && [ -r "$PROC/$pid/cmdline" ]; then
    cwd="$(readlink "$PROC/$pid/cwd" 2>/dev/null)"
    echo "process $pid: cwd=${cwd:-unreadable} exe=$(readlink "$PROC/$pid/exe" 2>/dev/null || echo unreadable)"
    n=0; shown=""
    while IFS= read -r -d '' a; do
      if [[ "$a" =~ ^[A-Za-z0-9_./-]+\.(c|m)?js$ || "$a" =~ ^[A-Za-z0-9_./-]+\.py$ ]]; then shown="$shown $a"; else n=$((n + 1)); fi
    done < "$PROC/$pid/cmdline"
    echo "   script arguments:${shown:- none}   (+$n other arguments, not shown)"
    if tr '\0' '\n' < "$PROC/$pid/cmdline" | grep -qE '^--token($|=)'; then echo "   cloudflared token mode (ingress managed in the Cloudflare dashboard): yes"; fi
    [ -r "$PROC/$pid/environ" ] && load_env_text process < <(tr '\0' '\n' < "$PROC/$pid/environ")
    [ -r "$PROC/$pid/environ" ] || echo "   process environment not readable (re-run with sudo for it)"
    if [ -n "$cwd" ] && [ -d "$cwd" ]; then
      if command -v git >/dev/null 2>&1 && { [ -e "$cwd/.git" ] || [ -e "$cwd/../.git" ]; }; then
        g() { git -c core.fsmonitor=false -c "safe.directory=$cwd" -c core.hooksPath=/dev/null --no-optional-locks -C "$cwd" "$@"; }
        echo "   git HEAD: $(g rev-parse HEAD 2>/dev/null | head -1)   tracked files modified: $(g status --porcelain --untracked-files=no 2>/dev/null | wc -l)"
      else echo "   git: directory is not a repository (normal for a copied directory)"; fi
      echo "   backend files vs reference releases:"
      hash_report "$cwd" server.js madineni-lyrics.cjs lyrics-player.js lyrics-core.cjs package.json
    fi
  else
    echo "process: not running or not readable"
  fi
  report_vars
  local fe="${VARS[FRONTEND_DIR]:-}"
  [ -n "$fe" ] && [ -d "$fe" ] && { echo "   frontend page vs reference releases:"; hash_report "$fe" index.html; }
  VARS=(); SRC=()
}

nginx_summary() {
  local files=() f
  for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do [ -r "$f" ] && files+=("$f"); done
  [ "${#files[@]}" -gt 0 ] || { echo "no readable nginx configuration (not installed, or run with sudo)"; return; }
  awk '
    FNR == 1 { inlog = 0 }
    { line = $0; sub(/#.*/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line); if (line == "") next }
    inlog { print FILENAME ": log_format continues: " line; if (line ~ /;$/) inlog = 0; next }
    { d = $1 }
    d == "proxy_set_header" { v = $3; sub(/;$/, "", v); print FILENAME ": proxy_set_header " $2 " " (v ~ /^\$[A-Za-z0-9_]+$/ ? v : "<literal not shown>"); next }
    d == "add_header"       { print FILENAME ": add_header " $2 " <value not shown>"; next }
    d == "log_format"       { print FILENAME ": " line; if (line !~ /;$/) inlog = 1; next }
    d ~ /^(listen|server_name|proxy_pass|set_real_ip_from|real_ip_header|real_ip_recursive|allow|deny|access_log|return|ssl_protocols|location)$/ { print FILENAME ": " line }
  ' "${files[@]}"
}

main() {
  echo "### host"; uname -sr; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" )
  echo; echo "### candidate services"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1, $3, $4}' | grep -Ei 'music|madineni|node|cloudflared|airflow|tailscale|nginx' || echo "none matched"
    for unit in $(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -Ei 'music|madineni|cloudflared|airflow'); do inspect_unit "$unit"; done
  else echo "systemctl not available"; fi

  echo; echo "### listening TCP sockets (local address and process name only)"
  ss -ltnpH 2>/dev/null | awk '{ p = $0; sub(/.*users:\(\("/, "", p); sub(/".*/, "", p); if (p == $0) p = "-"; print $4, p }' | sort -u | head -40
  echo "(127.0.0.1/[::1] = local only; 0.0.0.0, *, [::] or a LAN/Tailscale address = reachable without passing the proxy)"

  echo; echo "### nginx directives relevant to client IP and HTTPS (header values and add_header values are not shown)"
  nginx_summary

  echo; echo "### cloudflared local config (hostnames/services only; dashboard-managed tunnels have none)"
  for c in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml "$HOME/.cloudflared/config.yml"; do
    [ -r "$c" ] && { echo "-- $c"; grep -E '^\s*(- hostname|hostname|service|noTLSVerify|httpHostHeader)' "$c"; }
  done

  echo; echo "### common app roots (existence only)"
  for d in /opt/musicapp/app /opt/musicapp/app/frontend /opt/musicapp/app/backend /opt/musicapp/music/Songs /opt/musicapp/covers /home/rk/Music-App /home/rk/Music-App/frontend /home/rk/Music-App/backend; do
    [ -e "$d" ] && echo "exists  $d" || echo "absent  $d"
  done
  for d in /opt/musicapp/app/frontend /home/rk/Music-App/frontend; do [ -e "$d/madineni" ] && echo "FOUND stray file $d/madineni (publicly served at /madineni)"; done
  echo; echo "Database: run scripts/inspect_live_db.sql separately (read-only catalogue queries); logs: scripts/inspect_access_logs.sh."
}

main 2>&1 | scrub
