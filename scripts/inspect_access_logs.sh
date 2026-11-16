#!/usr/bin/env bash
# READ-ONLY aggregate summary of web-server access logs ("combined" format: nginx/Apache default).
# Usage:  bash inspect_access_logs.sh LOGFILE [LOGFILE...]     (plain or .gz; give files oldest first)
#
# Output contains ONLY: fixed labels, request methods, normalised /api paths (numbers -> :id, any segment
# that is not a short word -> :x), status codes, bucketed paging values, counts and calendar dates. It
# never prints IP addresses, query strings or values, tokens, user agents, referrers, user names or any
# raw log line. It reads the given files and writes nothing.
#
# CLIENT_CLASS=1 additionally groups write and un-paged requests into coarse client classes
# (apple-native, browser, script, other) derived from the user agent; the agent text is never printed.
#
# An absence of recent writes does NOT establish client compatibility: logs rotate, apps are used
# rarely, and a client that has never written yet may write after the token requirement ships.
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: $0 LOGFILE [LOGFILE...]" >&2; exit 2; }
for f in "$@"; do [ -r "$f" ] || { echo "not readable: $f" >&2; exit 2; }; done

zcat -f -- "$@" | awk -v cc="${CLIENT_CLASS:-0}" '
function norm(path,    n, seg, i, out, s) {
  n = split(path, seg, "/"); out = ""
  for (i = 2; i <= n; i++) {
    s = seg[i]
    if (s == "") continue
    if (s ~ /^[0-9]+$/) s = ":id"
    else if (!(s ~ /^[A-Za-z][A-Za-z_.-]*$/ && length(s) <= 24)) s = ":x"
    out = out "/" s
  }
  return out == "" ? "/" : out
}
function bucket(v) {
  if (v == "") return "absent"
  if (v !~ /^[0-9]+$/) return "invalid"
  v += 0
  return v <= 100 ? "1-100" : (v <= 500 ? "101-500" : ">500")
}
function qget(q, name,    re, m) {
  re = "(^|&)" name "=[^&]*"
  if (match(q, re)) { m = substr(q, RSTART, RLENGTH); sub(/^&?[^=]*=/, "", m); return m }
  return ""
}
function qhas(q, name) { return (q ~ ("(^|&)" name "=")) }
function klass(ua) {
  if (ua ~ /CFNetwork|Darwin/) return "apple-native"
  if (ua ~ /Mozilla/) return "browser"
  if (ua ~ /curl|python|node|axios|okhttp|Go-http|wget|Java|libwww/) return "script"
  return "other"
}
{
  total++
  if (!match($0, /"[A-Z]+ [^ "]+ HTTP\/[0-9.]+" [0-9][0-9][0-9]/)) { unparsed++; next }
  req = substr($0, RSTART, RLENGTH)
  split(req, p, " ")
  method = substr(p[1], 2); target = p[2]; status = p[4]
  ua = ""; if (cc == 1 && match($0, /"[^"]*"$/)) ua = substr($0, RSTART, RLENGTH)
  if (match($0, /\[[0-9][0-9]\/[A-Za-z][A-Za-z][A-Za-z]\/[0-9][0-9][0-9][0-9]/)) {
    d = substr($0, RSTART + 1, 11); if (first == "") first = d; last = d
  }
  qi = index(target, "?"); path = qi ? substr(target, 1, qi - 1) : target; q = qi ? tolower(substr(target, qi + 1)) : ""
  if (path !~ /^\/api(\/|$)/) { nonapi++; next }
  api++
  np = norm(path)
  mcount[(method ~ /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/) ? method : "OTHER"]++
  if (q ~ /(^|&)(token|access_token|admin_token|auth|authorization|api_key|apikey|key|password|secret)=/) credq++
  if (method !~ /^(GET|HEAD|OPTIONS)$/) {
    wr[method "\t" np "\t" status]++
    if (cc == 1) wcl[klass(ua)]++
  }
  if (method == "GET" && np ~ /^\/api\/songs\/:id\/lyrics$/ && qget(q, "refresh") == "1") refresh[status]++
  if (method == "GET" && np == "/api/songs") {
    pg[bucket(qget(q, "limit")) "\t" (qhas(q, "offset") ? "offset" : "no-offset")]++
    if (!qhas(q, "limit") && cc == 1) upcl[klass(ua)]++
  }
}
function section(title) { print ""; print "### " title }
function topn(cnt, ord,    k, n, i, j, t) {  # keys of cnt sorted by count, descending (small arrays)
  n = 0; for (k in cnt) ord[++n] = k
  for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (cnt[ord[j]] > cnt[ord[i]] || (cnt[ord[j]] == cnt[ord[i]] && ord[j] < ord[i])) { t = ord[i]; ord[i] = ord[j]; ord[j] = t }
  return n
}
END {
  print "### scope"
  print "lines read: " total "; lines not in combined format (skipped): " unparsed + 0
  print "first / last request date seen (file order): " (first == "" ? "none" : first " / " last)
  print "requests to /api: " api + 0 "; to other paths (not summarised): " nonapi + 0

  section("request methods on /api (PUT and PATCH listed explicitly)")
  nm = split("GET HEAD OPTIONS POST PUT PATCH DELETE OTHER", ml, " ")
  for (i = 1; i <= nm; i++) print mcount[ml[i]] + 0 "\t" ml[i]

  section("non-read requests on /api: count, method, normalised path, status (any row here is a client that writes)")
  n = topn(wr, o)
  for (i = 1; i <= n; i++) { split(o[i], f, "\t"); print wr[o[i]] "\t" f[1] "\t" f[2] "\t" f[3] }
  if (!n) print "none in these logs"

  section("explicit lyrics refresh (GET .../lyrics with refresh=1): count by status (needs the token after deployment)")
  n = topn(refresh, o)
  for (i = 1; i <= n; i++) print refresh[o[i]] "\t" o[i]
  if (!n) print "none in these logs"

  section("GET /api/songs paging: count, limit bucket, offset present (requests with no limit get only the default page after deployment)")
  n = topn(pg, o)
  for (i = 1; i <= n; i++) print pg[o[i]] "\t" o[i]
  if (!n) print "none in these logs"

  section("requests whose query string carries a credential-like parameter name (tokens must never be in URLs)")
  print credq + 0 " request(s); names and values are not shown"

  if (cc == 1) {
    section("client class of non-read requests")
    for (c in wcl) print wcl[c] "\t" c
    section("client class of GET /api/songs requests with NO limit")
    for (c in upcl) print upcl[c] "\t" c
  }
}'
