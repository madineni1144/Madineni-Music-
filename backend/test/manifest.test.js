"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const manifest = fs.readFileSync(path.join(root, "docs", "DEPLOYMENT.md"), "utf8");

function list(dir, pattern) {
  return fs.readdirSync(path.join(root, dir))
    .filter((f) => pattern.test(f))
    .map((f) => `${dir}/${f}`);
}

test("deployment manifest lists every runtime file (nothing silently omitted)", () => {
  const runtime = [
    ...list("backend", /\.(js|cjs)$/),            // server and all of its modules
    "backend/package.json",
    ...list("frontend", /\.html$/),
    ...list("frontend-demo", /\.html$/),
    ...list("audio_pipeline/scripts", /\.py$/).map((f) => f),
    "airflow/Dockerfile"
  ];
  const missing = runtime.filter((file) => {
    // pipeline scripts and a few others are listed by basename inside one table cell
    return !manifest.includes(file) && !manifest.includes("`" + path.basename(file) + "`");
  });
  assert.deepEqual(missing, []);
});

test("every backend module required by server.js is in the manifest (no MODULE_NOT_FOUND on deploy)", () => {
  const source = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
  const required = [...source.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(required.length >= 6);
  for (const name of required) {
    const file = fs.existsSync(path.join(root, "backend", name + ".js")) ? `${name}.js` : name;
    assert.ok(manifest.includes("`backend/" + file + "`"), `manifest misses backend/${file}`);
  }
});

test("manifest keeps the live directory unverified and documents a writes-blocked rollback", () => {
  assert.match(manifest, /live directory is NOT assumed/i);
  assert.match(manifest, /UNVERIFIED/);
  assert.match(manifest, /re-opens public write access/i);
  assert.ok(fs.existsSync(path.join(root, "docs", "rollback", "block-writes-on-2b64c13.patch")));
});
