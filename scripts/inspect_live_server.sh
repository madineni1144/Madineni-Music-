#!/usr/bin/env bash
# READ-ONLY inspection of the live Ubuntu host. Run it ON THE SERVER (as the service
# owner or with sudo for process details). It changes nothing and prints no secret values:
#   * environment files / unit Environment= lines are listed by KEY NAME only
#     (allow-listed non-secret keys show their value)
#   * no database connection is made; no file under the app is modified
# Share the output with whoever reviews the deployment checklist.
set -uo pipefail
SHOW_VALUES='^(PORT|NODE_ENV|FRONTEND_DIR|MUSIC_DIR|COVERS_DIR|ENV_FILE|CORS_ORIGINS|MUSICAPP_PROXY_MODE|MUSICAPP_TRUSTED_PROXIES|MUSICAPP_REQUIRE_HTTPS|MUSICAPP_MAX_PAGE_SIZE|MUSICAPP_DEFAULT_PAGE_SIZE)$'
redact() { sed -E 's/(Environment=)([A-Za-z0-9_]+)=.*/\1\2=<redacted>/; s/(PASSWORD|TOKEN|SECRET|KEY)[A-Za-z0-9_]*=.*/\1...=<redacted>/I'; }
keys() { # list KEY names of an env file; show values only for allow-listed keys
  local f="$1"
  [ -r "$f" ] || { echo "   (not readable: $f)"; return; }
  grep -Ev '^\s*(#|$)' "$f" | while IFS='=' read -r k v; do
    k="${k#export }"
    if [[ "$k" =~ $SHOW_VALUES ]]; then echo "   $k=$v"; else echo "   $k=<set, not shown>"; fi
  done
}

echo "### host"; uname -a; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo; echo "### candidate services (music / node / cloudflared / airflow)"
systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -Ei 'music|node|cloudflared|airflow|tailscale' || echo "none matched"

for unit in $(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{print $1}' | grep -Ei 'music|cloudflared|airflow'); do
  echo; echo "=== $unit"
  systemctl show "$unit" -p FragmentPath -p User -p WorkingDirectory -p ExecStart -p EnvironmentFiles -p MainPID -p ActiveState 2>/dev/null | redact
  echo "--- unit file (Environment values redacted)"
  systemctl cat "$unit" 2>/dev/null | redact
  for ef in $(systemctl show "$unit" -p EnvironmentFiles --value 2>/dev/null | tr ' ' '\n' | grep '^/' ); do
    echo "--- EnvironmentFile $ef"; stat -c '   mode=%a owner=%U:%G' "$ef" 2>/dev/null; keys "$ef"
  done
  pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null)"
  if [ -n "$pid" ] && [ "$pid" != 0 ] && [ -r "/proc/$pid/cwd" ]; then
    echo "--- process $pid"
    echo "   cwd:  $(readlink "/proc/$pid/cwd")"
    echo "   exe:  $(readlink "/proc/$pid/exe")"
    echo "   argv: $(tr '\0' ' ' < /proc/$pid/cmdline)"
    if [ -r "/proc/$pid/environ" ]; then
      echo "   environment (keys; allow-listed values only):"
      tr '\0' '\n' < "/proc/$pid/environ" | while IFS='=' read -r k v; do
        if [[ "$k" =~ $SHOW_VALUES ]]; then echo "     $k=$v"; else echo "     $k=<set, not shown>"; fi
      done | sort
    fi
    cwd="$(readlink "/proc/$pid/cwd")"
    if [ -d "$cwd" ]; then
      echo "   git: $(git -C "$cwd" rev-parse --short HEAD 2>&1 | head -1)  (dirty files: $(git -C "$cwd" status --short 2>/dev/null | wc -l))"
      echo "   sha256 of key files (compare with: git show 2b64c13:<path> | sha256sum):"
      for f in server.js madineni-lyrics.cjs lyrics-player.js package.json ../frontend/index.html; do
        [ -f "$cwd/$f" ] && sha256sum "$cwd/$f"
      done
    fi
  fi
done

echo; echo "### listening TCP sockets (ports 3000/8081/20241 are of interest)"
ss -ltnp 2>/dev/null | grep -E ':3000|:8081|:20241|State' || ss -ltn 2>/dev/null | head -20

echo; echo "### cloudflared ingress (hostnames/services only)"
for c in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml "$HOME/.cloudflared/config.yml"; do
  [ -r "$c" ] && { echo "-- $c"; grep -E '^\s*(- hostname|hostname|service|originRequest|noTLSVerify|httpHostHeader)' "$c"; }
done

echo; echo "### common app roots (existence only)"
for d in /opt/musicapp/app /opt/musicapp/app/frontend /opt/musicapp/app/backend /opt/musicapp/music/Songs /opt/musicapp/covers /home/rk/Music-App /home/rk/Music-App/frontend /home/rk/Music-App/backend; do
  [ -e "$d" ] && echo "exists  $d" || echo "absent  $d"
done
echo; echo "### stray 'madineni' file in any static root"
for d in /opt/musicapp/app/frontend /home/rk/Music-App/frontend; do [ -e "$d/madineni" ] && echo "FOUND $d/madineni (publicly served at /madineni)"; done
echo; echo "Optional (needs DB credentials, run yourself): psql -d music_app -c '\\d songs' -c '\\d artists' -c '\\d albums'"
