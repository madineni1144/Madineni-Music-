"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Static safety net: every mutating route registration (post/put/patch/delete)
 * must reference the write guard. Works without express installed.
 */
const files = ["server.js", "madineni-lyrics.cjs"].map((f) => [f, fs.readFileSync(path.join(__dirname, "..", f), "utf8")]);

function mutatingRegistrations(source) {
  const found = [];
  const re = /app\.(post|put|patch|delete)\(\s*([\s\S]*?)(?=\n\s*async|\n\s*\(req|,\s*async|,\s*\(req)/g;
  let m;
  while ((m = re.exec(source))) found.push({ method: m[1], head: m[2] });
  return found;
}

test("all mutating routes are registered behind the write guard", () => {
  let total = 0;
  for (const [name, source] of files) {
    for (const route of mutatingRegistrations(source)) {
      total += 1;
      assert.match(route.head, /writeGuard|denyWrites/, `${name}: unguarded ${route.method} ${route.head.slice(0, 60)}`);
    }
  }
  assert.equal(total, 5, "expected the 4 playlist writes + 1 lyrics write");
});

test("the lyrics module fails closed when no guard is supplied", () => {
  const source = files.find(([n]) => n === "madineni-lyrics.cjs")[1];
  assert.match(source, /options\.writeGuard\|\|denyWrites/);
  assert.equal(/writeGuard\|\|\(\(req,res,next\)=>next\(\)\)/.test(source), false);
});

test("no code path reads the retired ADMIN_TOKEN name", () => {
  for (const [name, source] of files) assert.equal(/ADMIN_TOKEN/.test(source), false, name);
});

test("explicit lyrics refresh is guarded and fails closed when no guard is supplied", () => {
  const lyrics = files.find(([n]) => n === "madineni-lyrics.cjs")[1];
  assert.match(lyrics, /options\.refreshGuard\|\|denyWrites/);
  assert.match(lyrics, /wantsRefresh\(req\)\?refreshGuard\(req,res,next\):next\(\)/);
  const server = files.find(([n]) => n === "server.js")[1];
  assert.match(server, /refreshGuard\s*=\s*chain\(\s*writeGuard,\s*refreshThrottle/);
  assert.match(server, /mount\(app, pool,[^)]*refreshGuard/);
});

test("Express trust-proxy is never enabled (forwarded headers only via proxy.js)", () => {
  const server = files.find(([n]) => n === "server.js")[1];
  assert.equal(/app\.set\(\s*["']trust proxy["']/.test(server), false);
  assert.equal(/req\.secure|req\.protocol|req\.ip\b/.test(server), false);
});
