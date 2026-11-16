"use strict";
// Adversarial composition tests: real proxy-trust + real write guard + real limiters with PRODUCTION limits.
// They need no express, so they run everywhere (sandbox and CI).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createProxyTrust } = require("../proxy");
const { requireWriteAuth } = require("../http-utils");
const { createRateLimiter } = require("../rate-limit");
const { loadConfig } = require("../config");

const TOKEN = "k".repeat(48);
const cfg = loadConfig({});

function build(mode, trusted) {
  const proxy = createProxyTrust({ mode, trustedProxies: trusted });
  const guard = requireWriteAuth({
    token: TOKEN, configured: true, requireHttps: false, isSecure: proxy.isSecure, clientIp: proxy.clientIp,
    failLimiter: createRateLimiter({ windowMs: cfg.authFailWindowMs, max: cfg.authFailMax }),
    globalFailLimiter: createRateLimiter({ windowMs: cfg.authFailWindowMs, max: cfg.authFailGlobalMax, maxKeys: 1 })
  });
  return (peer, headers) => {
    let status = "next";
    const req = { socket: { remoteAddress: peer }, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    const res = { status(c) { status = c; return this; }, json() {}, set() {} };
    guard(req, res, () => {});
    return status;
  };
}
const bad = { authorization: "Bearer wrong" };
const good = { authorization: `Bearer ${TOKEN}` };

test("production limits are unchanged (10 failures / 15 min per client, 200 global)", () => {
  assert.deepEqual([cfg.authFailMax, cfg.authFailWindowMs, cfg.authFailGlobalMax], [10, 900000, 200]);
});

for (const mode of ["none", "cloudflare"]) {
  test(`${mode}: an UNTRUSTED peer cannot evade lockout by rotating forwarding headers`, () => {
    const call = build(mode, ["loopback"]);
    const peer = "198.51.100.9"; // direct client, not loopback
    const out = [];
    for (let i = 0; i < 14; i++) {
      out.push(call(peer, { ...bad, "CF-Connecting-IP": `203.0.113.${i + 1}`, "X-Forwarded-For": `192.0.2.${i + 1}`,
        "X-Real-IP": `192.0.2.${100 + i}`, Forwarded: `for=192.0.2.${i + 1}`, "True-Client-IP": `192.0.2.${200 + i}` }));
    }
    assert.deepEqual(out, [...Array(9).fill(401), ...Array(5).fill(429)], "locked at the 10th failure regardless of headers");
    assert.equal(call(peer, { ...good, "CF-Connecting-IP": "203.0.113.250" }), 429, "even a forged-clean identity plus the right token stays locked out");
  });
}

test("mode none: a loopback peer's forwarding headers are ignored as well", () => {
  const call = build("none", ["loopback"]);
  const out = [];
  for (let i = 0; i < 11; i++) out.push(call("127.0.0.1", { ...bad, "CF-Connecting-IP": `203.0.113.${i + 1}` }));
  assert.equal(out[8], 401); assert.equal(out[9], 429);
});

test("cloudflare mode: malformed or multi-valued CF-Connecting-IP falls back to the peer key (cannot mint identities)", () => {
  const call = build("cloudflare", ["loopback"]);
  const junk = ["garbage", "1.2.3.4, 5.6.7.8", "1.2.3.4:80", "", " ", "999.1.1.1", "203.0.113.5\r\nX: y", "<script>"];
  const out = [];
  for (let i = 0; i < 12; i++) out.push(call("127.0.0.1", { ...bad, "CF-Connecting-IP": junk[i % junk.length] }));
  assert.equal(out.indexOf(429), 9, "all junk values share the loopback peer's bucket and lock at the 10th failure");
});

test("cloudflare mode: IPv4-mapped IPv6 spellings of one address are one client", () => {
  const call = build("cloudflare", ["loopback"]);
  const spellings = ["203.0.113.5", "::ffff:203.0.113.5"];
  const out = [];
  for (let i = 0; i < 11; i++) out.push(call("::1", { ...bad, "CF-Connecting-IP": spellings[i % 2] }));
  assert.equal(out.indexOf(429), 9);
});

test("cloudflare mode: genuine distinct clients behind the trusted proxy are limited independently", () => {
  const call = build("cloudflare", ["loopback"]);
  for (let i = 0; i < 9; i++) assert.equal(call("127.0.0.1", { ...bad, "CF-Connecting-IP": "203.0.113.1" }), 401);
  assert.equal(call("127.0.0.1", { ...bad, "CF-Connecting-IP": "203.0.113.1" }), 429);
  assert.equal(call("127.0.0.1", { ...bad, "CF-Connecting-IP": "203.0.113.2" }), 401, "another client is unaffected");
});

test("global ceiling still answers 429 to failures spread over many addresses behind the trusted proxy", () => {
  const call = build("cloudflare", ["loopback"]);
  let first429 = -1;
  for (let i = 0; i < 260; i++) {
    const s = call("127.0.0.1", { ...bad, "CF-Connecting-IP": `10.${i >> 8}.${i & 255}.1` });
    if (s === 429 && first429 < 0) first429 = i;
  }
  assert.equal(first429, 199, "the 200th failure trips the global ceiling");
  // Documented design: the global ceiling never blocks a correct token (that would let attackers lock the admin out).
  assert.equal(call("127.0.0.1", { ...good, "CF-Connecting-IP": "10.9.9.9" }), "next");
});
