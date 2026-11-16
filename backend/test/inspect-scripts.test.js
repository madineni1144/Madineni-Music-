"use strict";

// Tests for the server-inspection scripts (scripts/inspect_live_server.sh, inspect_access_logs.sh,
// inspect_live_db.sql). They run the scripts against FAKE systemctl/proc data containing planted secrets and
// fail if any planted secret reaches the output. Nothing here touches a real server or database.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const SCRIPTS = path.join(__dirname, "..", "..", "scripts");
const SERVER_SH = path.join(SCRIPTS, "inspect_live_server.sh");
const LOGS_SH = path.join(SCRIPTS, "inspect_access_logs.sh");
const DB_SQL = path.join(SCRIPTS, "inspect_live_db.sql");

const read = (p) => fs.readFileSync(p, "utf8");
const codeOf = (p) => read(p).split("\n").filter((l) => !/^\s*(#|--)/.test(l)).join("\n");

test("inspection scripts contain no write, restart, network or database-connecting commands", () => {
  const forbidden = [
    [/\bsystemctl\s+(restart|start|stop|reload|enable|disable|daemon-reload|edit|mask|unmask|kill|set-property)\b/, "systemctl mutation"],
    [/\b(rm|mv|cp|tee|dd|truncate|chmod|chown|ln|mkdir|touch|install)\s/, "file mutation command"],
    [/\bsed\s+(-[a-z]*i|--in-place)/, "sed -i"],
    [/\b(kill|pkill|killall|reboot|shutdown)\b/, "process control"],
    [/\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/, "network client"],
    [/\b(psql|pg_dump|mysql|sqlite3)\b/, "database client"],
    [/\bgit\s+(-\S+\s+\S+\s+)*(checkout|pull|fetch|reset|clean|add|commit|merge|stash|gc)\b/, "git mutation"],
    [/\bnginx\s+-[stT]/, "nginx test/dump"]
  ];
  for (const file of [SERVER_SH, LOGS_SH]) {
    const code = codeOf(file).replace(/2>&1|2>\/dev\/null|>\/dev\/null|>&2|<\(/g, "").replace(/'[^']*'/g, "''");
    for (const [re, label] of forbidden) assert.doesNotMatch(code, re, `${path.basename(file)}: ${label}`);
    // output redirection to a file would be a write
    const noStr = code.replace(/"(\\.|[^"\\])*"/g, '""');
    // a redirect to a file: ">" or ">>" followed by a name/variable/path (awk comparisons like "i > 1" and ">=" are not redirects)
    assert.doesNotMatch(noStr, /(^|[^<>=!|&0-9-])>>?[ \t]*(?!\/dev\/null|&|=|[0-9(])[\w"$\/.~]/m, `${path.basename(file)}: redirects output to a file`);
  }
  assert.match(read(SERVER_SH), /--no-optional-locks/, "git must not refresh the index");
  assert.match(read(SERVER_SH), /core\.fsmonitor=false/, "git must not run an fsmonitor command");
});

test("inspection SQL is read-only and never reads application rows", () => {
  const sql = codeOf(DB_SQL).split("\n").filter((l) => !/^\s*\\echo/.test(l)).join("\n").replace(/'[^']*'/g, "''");
  assert.match(sql, /BEGIN READ ONLY;/);
  assert.match(sql, /ROLLBACK;/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL)\s/i);
  assert.doesNotMatch(sql, /\bCREATE\s+(TABLE|INDEX|ROLE|FUNCTION|EXTENSION)\b/i);
  // no SELECT ... FROM <application table>: only catalogue relations
  assert.doesNotMatch(sql, /\bFROM\s+(public\.)?(songs|artists|albums|playlists|playlist_songs|madineni_song_lyrics)\b/i);
  assert.doesNotMatch(sql, /\bcount\(\*\)\s+FROM\s+(songs|artists|albums|playlists|playlist_songs)/i);
});

// ---------------------------------------------------------------------------------------------------------------
function fakeHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-test-"));
  const bin = path.join(root, "bin");
  const proc = path.join(root, "proc");
  const app = path.join(root, "app");
  fs.mkdirSync(bin); fs.mkdirSync(path.join(proc, "4242"), { recursive: true }); fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "server.js"), "// not a reference release\n");
  const S = {
    cfToken: "eyJPLANTEDCLOUDFLAREDTOKEN0123456789abcdefghijklmnop",
    urlPass: "PLANTED_URL_PASSWORD_42",
    unitPass: "PLANTED_UNIT_PASSWORD_43",
    envFilePass: "PLANTED_ENVFILE_DB_PASSWORD_44",
    writeToken: "PLANTED_WRITE_TOKEN_0123456789abcdefghijklmnop",
    adminToken: "PLANTED_LEGACY_ADMIN_TOKEN_45",
    pemLine: "PLANTED_PEM_BODY_LINE_46",
    procPass: "PLANTED_PROCESS_ENV_PASSWORD_47",
    argvSecret: "PLANTED_ARGV_SECRET_48"
  };
  const envFile = path.join(root, "app.env");
  fs.writeFileSync(envFile, [
    `MUSICAPP_WRITE_TOKEN=${S.writeToken}`, `ADMIN_TOKEN=${S.adminToken}`, `DB_PASSWORD=${S.envFilePass}`,
    "-----BEGIN PRIVATE KEY-----", S.pemLine, "-----END PRIVATE KEY-----", "CORS_ORIGINS=https://music.example"
  ].join("\n"));
  fs.writeFileSync(path.join(proc, "4242", "cmdline"),
    ["/usr/bin/cloudflared", "tunnel", "run", "--token", S.cfToken, "/opt/app/server.js", "--secret", S.argvSecret].join("\0") + "\0");
  fs.writeFileSync(path.join(proc, "4242", "environ"),
    [`DB_PASSWORD=${S.procPass}`, `MUSICAPP_WRITE_TOKEN=${S.writeToken}`, "PORT=3000", "MUSICAPP_PROXY_MODE=cloudflare", "HOME=/home/rk"].join("\0") + "\0");
  fs.symlinkSync(app, path.join(proc, "4242", "cwd"));
  fs.symlinkSync("/usr/bin/node", path.join(proc, "4242", "exe"));
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash
case "$*" in
 *list-units*) echo "musicapp.service loaded active running Music app";;
 *"-p ExecStart --value"*) echo "{ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared tunnel run --token ${S.cfToken} ; ignore_errors=no }";;
 *"-p Environment --value"*) echo 'DATABASE_URL=postgres://dbuser:${S.urlPass}@db/x "DB_PASSWORD=${S.unitPass}" NODE_ENV=production';;
 *"EnvironmentFiles --value"*) echo "${envFile} (ignore_errors=no)";;
 *"MainPID --value"*) echo 4242;;
 *show*) printf 'FragmentPath=/etc/systemd/system/musicapp.service\\nUser=rk\\nWorkingDirectory=${app}\\nMainPID=4242\\nActiveState=active\\n';;
 *cat*) echo "ExecStart=/usr/bin/cloudflared tunnel run --token ${S.cfToken}";;
esac
`, { mode: 0o755 });
  return { root, bin, proc, S };
}

test("server inspection output never contains a planted secret, and reports names by presence only", () => {
  const h = fakeHost();
  const r = spawnSync("bash", [SERVER_SH], {
    encoding: "utf8",
    env: { PATH: `${h.bin}:${process.env.PATH}`, INSPECT_PROC_ROOT: h.proc, HOME: h.root, LANG: "C" }
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out);
  for (const [name, secret] of Object.entries(h.S)) assert.ok(!out.includes(secret), `leaked ${name}`);
  for (const frag of ["dbuser", "BEGIN PRIVATE KEY", "END PRIVATE KEY", "eyJPLANTED", "PLANTED_"]) assert.ok(!out.includes(frag), `leaked fragment ${frag}`);
  assert.match(out, /MUSICAPP_WRITE_TOKEN: present, length>=32: yes/);
  assert.match(out, /ADMIN_TOKEN: present/);
  assert.match(out, /DB_PASSWORD: present/);
  assert.match(out, /DB_HOST: absent/);
  assert.match(out, /MUSICAPP_PROXY_MODE=cloudflare/);
  assert.match(out, /PORT=3000/);
  assert.match(out, /cloudflared token mode[^\n]*yes/);
  assert.match(out, /server\.js: matches NEITHER/);
  assert.match(out, /ExecStart executable: \/usr\/bin\/cloudflared +\(arguments are never printed\)/);
  assert.match(out, /script arguments: \/opt\/app\/server\.js/);
  fs.rmSync(h.root, { recursive: true, force: true });
});

test("the scrubber masks credentials even when they reach the output by an unforeseen path", () => {
  // run only the scrub function against hostile text
  const src = read(SERVER_SH);
  const fn = src.slice(src.indexOf("scrub() {"), src.indexOf("in_list()"));
  const prelude = `SHOW_VALUE_KEYS="PORT CORS_ORIGINS"\nPRESENCE_KEYS="MUSICAPP_WRITE_TOKEN"\nSAFE_VALUE_RE=x\n`;
  const text = [
    "ExecStart=/x --token eyJabcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdef0123456789secret",
    "postgres://user:hunter2@db.example/x",
    "     CORS_ORIGINS=https://music.example",
    "FragmentPath=/etc/systemd/system/a-long-unit-name.service",
    "sha 2ab27eaba958d75b5b8322ae7510d7787122ae797f7ffc22f87a93d564bc40cc"
  ].join("\n");
  const r = spawnSync("bash", ["-c", `${prelude}\n${fn}\nscrub`], { input: text, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("eyJabcdef")); assert.ok(!r.stdout.includes("abcdef0123456789secret")); assert.ok(!r.stdout.includes("hunter2"));
  assert.match(r.stdout, /CORS_ORIGINS=https:\/\/music\.example/);
  assert.match(r.stdout, /FragmentPath=\/etc\/systemd\/system\/a-long-unit-name\.service/);
  assert.match(r.stdout, /2ab27eaba958d75b5b8322ae7510d7787122ae797f7ffc22f87a93d564bc40cc/);
});

// ---------------------------------------------------------------------------------------------------------------
const LOG = [
  `203.0.113.7 - - [15/Nov/2026:10:00:00 -0500] "GET /api/songs?limit=500&offset=0 HTTP/1.1" 200 1234 "-" "Mozilla/5.0 PLANTED_UA_BROWSER"`,
  `203.0.113.7 - - [15/Nov/2026:10:00:01 -0500] "GET /api/songs?limit=500&offset=500 HTTP/1.1" 200 1234 "-" "Mozilla/5.0 PLANTED_UA_BROWSER"`,
  `198.51.100.9 - bobuser [15/Nov/2026:10:00:02 -0500] "GET /api/songs HTTP/1.1" 200 99 "-" "MusicApp/1.0 CFNetwork/1485 Darwin/23.1"`,
  `198.51.100.9 - - [15/Nov/2026:10:00:03 -0500] "GET /api/songs?limit=5000 HTTP/1.1" 200 99 "-" "MusicApp/1.0 CFNetwork/1485 Darwin/23.1"`,
  `198.51.100.9 - - [16/Nov/2026:10:00:03 -0500] "GET /api/songs?limit=PLANTED_BAD HTTP/1.1" 400 9 "-" "curl/8.0"`,
  `198.51.100.9 - - [16/Nov/2026:10:00:04 -0500] "POST /api/playlists HTTP/1.1" 401 55 "-" "MusicApp/1.0 CFNetwork/1485 Darwin/23.1"`,
  `198.51.100.9 - - [16/Nov/2026:10:00:05 -0500] "PUT /api/playlists/12 HTTP/1.1" 404 55 "-" "MusicApp/1.0 CFNetwork/1485 Darwin/23.1"`,
  `198.51.100.9 - - [16/Nov/2026:10:00:06 -0500] "PATCH /api/playlists/12?token=PLANTED_QUERY_TOKEN HTTP/1.1" 401 55 "-" "curl/8.0"`,
  `203.0.113.7 - - [16/Nov/2026:10:00:07 -0500] "DELETE /api/playlists/12/songs/99 HTTP/1.1" 200 5 "-" "Mozilla/5.0 PLANTED_UA_BROWSER"`,
  `203.0.113.7 - - [16/Nov/2026:10:00:08 -0500] "GET /api/songs/5/lyrics?refresh=1 HTTP/1.1" 200 5 "-" "Mozilla/5.0 PLANTED_UA_BROWSER"`,
  `203.0.113.7 - - [16/Nov/2026:10:00:09 -0500] "GET /api/PLANTED0123456789ABCDEFGHIJKLMNOPQRSTUV HTTP/1.1" 404 5 "-" "-"`,
  `203.0.113.7 - - [16/Nov/2026:10:00:10 -0500] "GET /index.html HTTP/1.1" 200 5 "-" "-"`,
  `this line is not in combined format PLANTED_GARBAGE`
].join("\n") + "\n";

function runLogs(files, env = {}) {
  return spawnSync("bash", [LOGS_SH, ...files], { encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C", ...env } });
}

test("access-log summary reports methods incl. PUT/PATCH and paging as aggregates, with no IPs, queries, tokens or agents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-logs-"));
  const plain = path.join(dir, "access.log");
  const gz = path.join(dir, "access.log.1.gz");
  fs.writeFileSync(plain, LOG);
  fs.writeFileSync(gz, zlib.gzipSync(LOG));
  for (const env of [{}, { CLIENT_CLASS: "1" }]) {
    const r = runLogs([plain], env);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    for (const secret of ["203.0.113.7", "198.51.100.9", "bobuser", "PLANTED_", "CFNetwork", "Darwin", "Mozilla", "curl/", "token=", "limit=", "offset=", "?"]) {
      assert.ok(!out.includes(secret), `leaked ${secret}`);
    }
    assert.match(out, /lines read: 13; lines not in combined format \(skipped\): 1/);
    assert.match(out, /first \/ last request date seen \(file order\): 15\/Nov\/2026 \/ 16\/Nov\/2026/);
    assert.match(out, /requests to \/api: 11; to other paths \(not summarised\): 1/);
    for (const m of [["GET", 7], ["POST", 1], ["PUT", 1], ["PATCH", 1], ["DELETE", 1], ["HEAD", 0], ["OPTIONS", 0]]) {
      assert.match(out, new RegExp(`^${m[1]}\\t${m[0]}$`, "m"), `method ${m[0]}`);
    }
    assert.match(out, /^1\tPOST\t\/api\/playlists\t401$/m);
    assert.match(out, /^1\tPUT\t\/api\/playlists\/:id\t404$/m);
    assert.match(out, /^1\tPATCH\t\/api\/playlists\/:id\t401$/m);
    assert.match(out, /^1\tDELETE\t\/api\/playlists\/:id\/songs\/:id\t200$/m);
    assert.match(out, /^1\t200$/m, "refresh row");
    assert.match(out, /^2\t101-500\toffset$/m);
    assert.match(out, /^1\tabsent\tno-offset$/m);
    assert.match(out, /^1\t>500\tno-offset$/m);
    assert.match(out, /^1\tinvalid\tno-offset$/m);
    assert.match(out, /^1 request\(s\); names and values are not shown$/m);
    assert.doesNotMatch(out, /PLANTED/);
    if (env.CLIENT_CLASS) {
      assert.match(out, /client class of non-read requests/);
      assert.match(out, /apple-native/);
    } else {
      assert.doesNotMatch(out, /client class/);
    }
  }
  const both = runLogs([plain, gz]);
  assert.match(both.stdout, /lines read: 26;/, "gzip input is read too");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("access-log summary says so plainly when there are no writes, and rejects unreadable input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-logs-"));
  const f = path.join(dir, "a.log");
  fs.writeFileSync(f, `203.0.113.7 - - [15/Nov/2026:10:00:00 -0500] "GET /api/songs?limit=100 HTTP/1.1" 200 1 "-" "x"\n`);
  const r = runLogs([f]);
  assert.match(r.stdout, /non-read requests on \/api[^\n]*\nnone in these logs/);
  assert.match(r.stdout, /^0\tPUT$/m);
  assert.equal(runLogs([path.join(dir, "missing.log")]).status, 2);
  assert.equal(spawnSync("bash", [LOGS_SH], { encoding: "utf8" }).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
