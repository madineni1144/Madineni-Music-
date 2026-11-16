"use strict";

// Tests for scripts/run_inspection.sh using synthetic fixtures only: a fake systemctl, a fake /proc tree, a fake
// psql and fake log files. Nothing here touches a real service, database or log.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SCRIPTS = path.join(__dirname, "..", "..", "scripts");
const FILES = ["run_inspection.sh", "inspect_live_server.sh", "inspect_access_logs.sh", "inspect_live_db.sql"];

const SECRETS = {
  dbPass: "PLANTED_DB_PASSWORD_9917",
  urlPass: "PLANTED_URL_PASSWORD_9918",
  token: "PLANTED_WRITE_TOKEN_0123456789abcdefghijklmnop",
  psqlErr: "PLANTED_PSQL_STDERR_SECRET_9919",
  pem: "PLANTED_PEM_BODY_9920"
};

function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

function fixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  const dir = path.join(root, "scripts"); fs.mkdirSync(dir);
  for (const f of FILES) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), FILES.map((f) => `${sha(path.join(dir, f))}  ${f}`).join("\n") + "\n");
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const proc = path.join(root, "proc"); const pid = "4242";
  fs.mkdirSync(path.join(proc, pid), { recursive: true });
  const env = opts.env === undefined ? [
    "DB_HOST=db.internal", "DB_PORT=5432", "DB_NAME=musicdb", "DB_USER=musicapp",
    `DB_PASSWORD=${SECRETS.dbPass}`, `MUSICAPP_WRITE_TOKEN=${SECRETS.token}`, "PORT=3000"
  ] : opts.env;
  if (opts.environ !== false) fs.writeFileSync(path.join(proc, pid, "environ"), env.join("\0") + "\0");
  const logs = path.join(root, "logs"); fs.mkdirSync(logs);
  if (opts.logs !== false) fs.writeFileSync(path.join(logs, "access.log"),
    `203.0.113.7 - - [15/Nov/2026:10:00:00 -0500] "GET /api/songs?limit=100 HTTP/1.1" 200 1 "-" "x"\n`);
  const calls = path.join(root, "psql-calls.txt");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash
case "$*" in
 *"-p LoadState"*) printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nMainPID=%s\\n' "\${FAKE_LOAD:-loaded}" "\${FAKE_ACTIVE:-active}" "\${FAKE_SUB:-running}" "\${FAKE_PID-4242}";;
 *list-units*) echo "musicapp.service loaded active running Music app"; echo "other.service loaded active running x";;
 *"MainPID --value"*) echo 4242;;
 *show*) printf 'FragmentPath=/etc/systemd/system/musicapp.service\\nUser=rk\\nWorkingDirectory=${root}\\nMainPID=4242\\nActiveState=active\\n';;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "fakepsql"), `#!/bin/bash
{ echo "ARGV: $*"; echo "PGSSLMODE=\${PGSSLMODE-<unset>} PGOPTIONS=\${PGOPTIONS-<unset>} PGPASSWORD=\${PGPASSWORD-<unset>}"; } >> "${calls}"
case "\${FAKE_PSQL:-ok}" in
 fail) echo "connection failed: ${SECRETS.psqlErr}" >&2; exit 2;;
 incomplete) echo "### session"; exit 0;;
 nossl) printf ' database | role | read_only_transaction\\n----------+------+----\\n m | a | on\\n'; echo "### end of catalogue inspection"; exit 0;;
 leaky) printf ' database | role | read_only_transaction\\n----------+------+----\\n m | a | on\\n'; echo "this_session_uses_tls"; echo "password: hunter2-planted"; echo "### end of catalogue inspection"; exit 0;;
 writable) printf ' database | role | read_only_transaction\\n----------+------+----\\n m | a | off\\n'; echo "this_session_uses_tls"; echo "### end of catalogue inspection"; exit 0;;
 *) printf ' database | role | read_only_transaction\\n----------+------+----\\n m | a | on\\n'; echo "this_session_uses_tls"; echo "### end of catalogue inspection"; exit 0;;
esac
`, { mode: 0o755 });
  return { root, dir, bin, proc, logs, calls };
}

function run(fx, args, extraEnv = {}) {
  return spawnSync("bash", [path.join(fx.dir, "run_inspection.sh"), ...args], {
    encoding: "utf8",
    env: {
      PATH: `${fx.bin}:${process.env.PATH}`, HOME: fx.root, LANG: "C",
      INSPECT_PROC_ROOT: fx.proc, INSPECT_PRIV: "", INSPECT_PSQL: path.join(fx.bin, "fakepsql"), ...extraEnv
    }
  });
}
const base = (fx) => ["--service", "musicapp.service", "--log-dir", fx.logs];
const all = (r) => `${r.stdout}\n${r.stderr}`;
const noSecrets = (text) => { for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `leaked ${k}`); assert.ok(!text.includes("hunter2"), "leaked hunter2"); };
const cleanup = (fx) => fs.rmSync(fx.root, { recursive: true, force: true });

test("happy path: passes only non-secret settings, mirrors the app's transport, records TLS evidence", () => {
  const fx = fixture(); const r = run(fx, base(fx));
  assert.equal(r.status, 0, all(r)); noSecrets(all(r));
  assert.match(r.stdout, /ok: sha256sum -c/);
  assert.match(r.stdout, /MainPID verified/);
  assert.match(r.stdout, /host=db\.internal port=5432 database=musicdb role=musicapp transport=tcp sslmode=disable/);
  assert.match(r.stdout, /not psql's default of prefer/);
  assert.match(r.stdout, /pg_stat_ssl recorded from the same session/);
  assert.match(r.stdout, /RUN COMPLETE/);
  const calls = fs.readFileSync(fx.calls, "utf8");
  assert.equal(calls.match(/^ARGV:/gm).length, 1, "exactly one database session");
  noSecrets(calls);
  assert.match(calls, /-h db\.internal/); assert.match(calls, /-U musicapp/); assert.match(calls, /-d musicdb/); assert.match(calls, /-p 5432/);
  assert.match(calls, /PGSSLMODE=disable/); assert.match(calls, /default_transaction_read_only=on/); assert.match(calls, /statement_timeout=5000/);
  assert.match(calls, /PGPASSWORD=<unset>/); assert.doesNotMatch(calls, / -W|--password/);
  cleanup(fx);
});

test("PG* variables set in the caller's shell cannot redirect the connection or leak a password into it", () => {
  const fx = fixture();
  const r = run(fx, base(fx), { PGHOST: "attacker.example", PGPASSWORD: "PLANTED_CALLER_PGPASSWORD", PGSSLMODE: "require" });
  assert.equal(r.status, 0, all(r));
  const calls = fs.readFileSync(fx.calls, "utf8");
  assert.match(calls, /-h db\.internal/); assert.match(calls, /PGPASSWORD=<unset>/); assert.match(calls, /PGSSLMODE=disable/);
  assert.ok(!calls.includes("attacker.example") && !calls.includes("PLANTED_CALLER"));
  cleanup(fx);
});

test("DATABASE_URL-only configuration: components used, password never exposed, URL sslmode preserved", () => {
  const fx = fixture({ env: [`DATABASE_URL=postgres://urole:${SECRETS.urlPass}@dbhost:6543/urldb?sslmode=require`, `MUSICAPP_WRITE_TOKEN=${SECRETS.token}`] });
  const r = run(fx, base(fx));
  assert.equal(r.status, 0, all(r)); noSecrets(all(r)); noSecrets(fs.readFileSync(fx.calls, "utf8"));
  assert.match(r.stdout, /host=dbhost port=6543 database=urldb role=urole transport=tcp sslmode=require.*from DATABASE_URL components/);
  assert.doesNotMatch(r.stdout, /postgres:\/\//);
  assert.match(fs.readFileSync(fx.calls, "utf8"), /PGSSLMODE=require/);
  cleanup(fx);
});

test("app sslmode is preserved; verify-* without a readable root certificate stops the run", () => {
  let fx = fixture({ env: ["DB_HOST=db", "DB_NAME=m", "DB_USER=u", "PGSSLMODE=require"] });
  assert.equal(run(fx, base(fx)).status, 0);
  assert.match(fs.readFileSync(fx.calls, "utf8"), /PGSSLMODE=require/); cleanup(fx);
  fx = fixture({ env: ["DB_HOST=db", "DB_NAME=m", "DB_USER=u", "PGSSLMODE=verify-full"] });
  let r = run(fx, base(fx)); assert.equal(r.status, 5, all(r)); assert.match(r.stderr, /root certificate/); assert.ok(!fs.existsSync(fx.calls)); cleanup(fx);
  fx = fixture({ env: ["DB_HOST=db", "DB_NAME=m", "DB_USER=u", "PGSSLMODE=bogus"] });
  r = run(fx, base(fx)); assert.equal(r.status, 5); cleanup(fx);
});

test("missing configuration stops without guessing a host, name, role or transport", () => {
  for (const env of [["DB_NAME=m", "DB_USER=u"], ["DB_HOST=h", "DB_USER=u"], ["DB_HOST=h", "DB_NAME=m"], ["PORT=3000"],
                     ["DB_HOST=h", "DB_NAME=m", "DB_USER=u", "PGSERVICE=x"], ["DATABASE_URL=not-a-url"],
                     ["DB_HOST=h$(id)", "DB_NAME=m", "DB_USER=u"]]) {
    const fx = fixture({ env }); const r = run(fx, base(fx));
    assert.ok([4, 5].includes(r.status), `${env.join(" ")} -> ${r.status}: ${all(r)}`);
    assert.ok(!fs.existsSync(fx.calls), "psql must not run"); assert.doesNotMatch(r.stdout, /RUN COMPLETE/);
    cleanup(fx);
  }
});

test("service discovery: no service lists candidates only; bad, stopped or zero-PID services stop", () => {
  let fx = fixture();
  let r = run(fx, []); assert.equal(r.status, 2); assert.match(r.stdout, /musicapp\.service/); assert.ok(!fs.existsSync(fx.calls)); cleanup(fx);
  fx = fixture();
  for (const [args, env, code] of [
    [["--service", "music*"], {}, 2], [["--service", "musicapp"], {}, 2], [["--service", "a b.service"], {}, 2],
    [["--service", "musicapp.service"], { FAKE_PID: "0" }, 3], [["--service", "musicapp.service"], { FAKE_PID: "" }, 3],
    [["--service", "musicapp.service"], { FAKE_SUB: "dead" }, 3], [["--service", "musicapp.service"], { FAKE_ACTIVE: "inactive" }, 3],
    [["--service", "musicapp.service"], { FAKE_LOAD: "not-found" }, 3], [["--service", "musicapp.service"], { FAKE_PID: "9999" }, 3]
  ]) {
    r = run(fx, [...args, "--log-dir", fx.logs], env); assert.equal(r.status, code, `${args.join(" ")} ${JSON.stringify(env)}: ${all(r)}`);
  }
  assert.ok(!fs.existsSync(fx.calls)); cleanup(fx);
});

test("environment access failures stop with a sanitised error", () => {
  let fx = fixture({ environ: false });
  let r = run(fx, base(fx)); assert.equal(r.status, 4, all(r)); noSecrets(all(r)); cleanup(fx);
  fx = fixture();
  const deny = path.join(fx.bin, "denypriv"); fs.writeFileSync(deny, `#!/bin/bash\necho "sudo: a password is required ${SECRETS.psqlErr}" >&2; exit 1\n`, { mode: 0o755 });
  r = run(fx, base(fx), { INSPECT_PRIV: deny }); assert.equal(r.status, 4, all(r)); noSecrets(all(r)); assert.match(r.stderr, /privileged read/); assert.ok(!fs.existsSync(fx.calls));
  cleanup(fx);
});

test("the privileged helper receives only the process id and root, never prints the environment", () => {
  const fx = fixture();
  const spy = path.join(fx.bin, "spypriv"); fs.writeFileSync(spy, `#!/bin/bash\necho "$@" > "${fx.root}/priv-args.txt"\nexec "$@"\n`, { mode: 0o755 });
  const r = run(fx, base(fx), { INSPECT_PRIV: spy }); assert.equal(r.status, 0, all(r)); noSecrets(all(r));
  const args = fs.readFileSync(path.join(fx.root, "priv-args.txt"), "utf8");
  assert.match(args, /^bash -c /); assert.ok(!args.includes(SECRETS.dbPass)); assert.ok(args.trim().endsWith(`${fx.proc} 4242`));
  cleanup(fx);
});

test("database failures stop; a failed or partial query never looks like success; psql stderr is not shown", () => {
  for (const [mode, re] of [["fail", /database connection or catalogue query failed/], ["incomplete", /incomplete/], ["nossl", /pg_stat_ssl evidence/], ["writable", /read-only/]]) {
    const fx = fixture(); const r = run(fx, base(fx), { FAKE_PSQL: mode });
    assert.equal(r.status, 8, `${mode}: ${all(r)}`); assert.match(r.stderr, re); noSecrets(all(r));
    assert.doesNotMatch(r.stdout, /RUN COMPLETE/); assert.doesNotMatch(r.stdout, /logs report complete|log report complete/);
    cleanup(fx);
  }
});

test("log discovery failures stop", () => {
  let fx = fixture({ logs: false }); let r = run(fx, base(fx)); assert.equal(r.status, 9, all(r)); assert.match(r.stderr, /no access\.log/); cleanup(fx);
  fx = fixture(); r = run(fx, ["--service", "musicapp.service", "--log-dir", path.join(fx.root, "nope")]); assert.equal(r.status, 9); cleanup(fx);
  if (process.getuid && process.getuid() !== 0) {
    fx = fixture(); fs.chmodSync(path.join(fx.logs, "access.log"), 0o000); r = run(fx, base(fx)); assert.equal(r.status, 9); cleanup(fx);
  }
});

test("checksum failure or missing SHA256SUMS stops before anything runs", () => {
  let fx = fixture(); fs.appendFileSync(path.join(fx.dir, "inspect_live_db.sql"), "-- tampered\n");
  let r = run(fx, base(fx)); assert.equal(r.status, 2); assert.match(r.stderr, /sha256sum -c failed/); assert.ok(!fs.existsSync(fx.calls)); cleanup(fx);
  fx = fixture(); fs.rmSync(path.join(fx.dir, "SHA256SUMS")); r = run(fx, base(fx)); assert.equal(r.status, 2); cleanup(fx);
});

test("leak check names files only, never matching text, and says it is not proof", () => {
  const fx = fixture(); const r = run(fx, base(fx), { FAKE_PSQL: "leaky" });
  assert.equal(r.status, 0, all(r)); noSecrets(all(r));
  assert.match(r.stdout, /files matching a pattern, review these first: .*db-report\.txt/);
  assert.match(r.stdout, /NOT proof/); assert.match(r.stdout, /Review every file/);
  assert.doesNotMatch(r.stdout, /password: /);
  cleanup(fx);
});

test("runner contains no write/restart/network commands and never prints reports", () => {
  const code = fs.readFileSync(path.join(SCRIPTS, "run_inspection.sh"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /\bsystemctl\s+(restart|start|stop|reload|enable|disable|daemon-reload|edit|mask|kill)\b/);
  assert.doesNotMatch(code, /\b(curl|wget|ssh|scp|nc)\b/);
  assert.doesNotMatch(code, /\b(rm|mv|cp|dd|chmod\s+[0-7]*[1-7][0-7]*\s|chown)\b\s/);
  assert.doesNotMatch(code, /\bcat\s+"?\$OUT/); assert.doesNotMatch(code, /\bsource\b|^\s*\.\s+["$]/m);
  assert.doesNotMatch(code, /sslmode=prefer|PGSSLMODE=prefer/);
});
