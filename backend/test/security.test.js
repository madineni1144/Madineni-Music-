"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProxyTrust } = require("../proxy");
const { createRateLimiter } = require("../rate-limit");
const { requireWriteAuth, refreshThrottle, chain } = require("../http-utils");
const { loadConfig } = require("../config");

const TOKEN = "s".repeat(40);

const req = (peer, headers = {}, extra = {}) => ({ socket: { remoteAddress: peer, ...extra.socket }, headers, ...extra.rest });
const CF = { "x-forwarded-proto": "https", "cf-visitor": '{"scheme":"https"}' };

function res() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; }
  };
}

// ---------- proxy trust & spoofed headers ----------

test("mode none: forwarded headers are never trusted, even from loopback", () => {
  const p = createProxyTrust({ mode: "none" });
  assert.equal(p.isSecure(req("127.0.0.1", CF)), false);
});

test("cloudflare mode: both headers from a trusted loopback peer prove HTTPS", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(p.isSecure(req(peer, CF)), true, peer);
  }
});

test("SPOOF: a direct (untrusted) client cannot claim HTTPS with forged headers", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  for (const peer of ["203.0.113.9", "192.168.4.50", "100.83.79.17", "10.0.0.2"]) {
    assert.equal(p.isSecure(req(peer, CF)), false, peer);
  }
});

test("SPOOF: forged X-Forwarded-Proto alone is not enough (CF-Visitor also required)", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  assert.equal(p.isSecure(req("127.0.0.1", { "x-forwarded-proto": "https" })), false);
  assert.equal(p.isSecure(req("127.0.0.1", { "cf-visitor": '{"scheme":"https"}' })), false);
});

test("SPOOF: client-supplied 'https' followed by the proxy's own 'http' is HTTP (rightmost wins)", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  assert.equal(p.isSecure(req("127.0.0.1", { ...CF, "x-forwarded-proto": "https, http" })), false);
  assert.equal(p.isSecure(req("127.0.0.1", { ...CF, "x-forwarded-proto": "http, https" })), true);
});

test("cloudflare mode: CF-Visitor must say https and be valid JSON", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  for (const v of ['{"scheme":"http"}', "not json", "", "{}", '{"scheme":["https"]}']) {
    assert.equal(p.isSecure(req("127.0.0.1", { "x-forwarded-proto": "https", "cf-visitor": v })), false, v);
  }
});

test("trusted proxy list can be an exact IP instead of loopback", () => {
  const p = createProxyTrust({ mode: "cloudflare", trustedProxies: ["10.9.9.9"] });
  assert.equal(p.isSecure(req("10.9.9.9", CF)), true);
  assert.equal(p.isSecure(req("127.0.0.1", CF)), false, "loopback not trusted unless listed");
});

test("direct TLS termination in this process counts as HTTPS in any mode", () => {
  const p = createProxyTrust({ mode: "none" });
  assert.equal(p.isSecure(req("198.51.100.4", {}, { socket: { encrypted: true } })), true);
});

test("clientIp: CF-Connecting-IP only honoured from a trusted peer and only if a valid IP", () => {
  const p = createProxyTrust({ mode: "cloudflare" });
  assert.equal(p.clientIp(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7" })), "198.51.100.7");
  assert.equal(p.clientIp(req("127.0.0.1", { "cf-connecting-ip": "garbage" })), "127.0.0.1");
  assert.equal(p.clientIp(req("203.0.113.9", { "cf-connecting-ip": "198.51.100.7" })), "203.0.113.9");
  assert.equal(createProxyTrust({ mode: "none" }).clientIp(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7" })), "127.0.0.1");
});

test("config: unknown proxy mode falls back to none; default is none", () => {
  assert.equal(loadConfig({}).proxyMode, "none");
  assert.equal(loadConfig({ MUSICAPP_PROXY_MODE: "cloudflare" }).proxyMode, "cloudflare");
  assert.equal(loadConfig({ MUSICAPP_PROXY_MODE: "trust-everything" }).proxyMode, "none");
});

// ---------- rate limiter ----------

test("limiter blocks after max hits, reports Retry-After, and recovers after the window", () => {
  let t = 1_000_000;
  const l = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
  assert.equal(l.hit("a"), null);
  assert.equal(l.hit("a"), null);
  const blocked = l.hit("a");
  assert.equal(blocked.retryAfterSec, 60);
  assert.ok(l.blocked("a"));
  assert.equal(l.blocked("b"), null, "other keys unaffected");
  t += 59_000; assert.equal(l.blocked("a").retryAfterSec, 1);
  t += 1_001;  assert.equal(l.blocked("a"), null);
});

test("limiter memory is bounded by maxKeys", () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 100 });
  for (let i = 0; i < 10_000; i++) l.hit(`ip-${i}`);
  assert.ok(l.size <= 100, `size ${l.size}`);
});

// ---------- failed-auth lockout ----------

function guard(extra = {}) {
  const failLimiter = createRateLimiter({ windowMs: 900_000, max: 3 });
  const globalFailLimiter = createRateLimiter({ windowMs: 900_000, max: 5, maxKeys: 1 });
  return requireWriteAuth({
    token: TOKEN, configured: true, requireHttps: false,
    clientIp: (r) => r.ip, failLimiter, globalFailLimiter, ...extra
  });
}
const call = (g, ip, auth) => {
  const r = res(); let passed = false;
  g({ ip, get: (h) => (h.toLowerCase() === "authorization" ? auth : undefined) }, r, () => { passed = true; });
  return { r, passed };
};

test("lockout: repeated bad tokens return 401 then 429 with Retry-After", () => {
  const g = guard();
  assert.equal(call(g, "1.1.1.1", "Bearer bad").r.statusCode, 401);
  assert.equal(call(g, "1.1.1.1", "Bearer bad").r.statusCode, 401);
  const third = call(g, "1.1.1.1", "Bearer bad");
  assert.equal(third.r.statusCode, 429);
  assert.equal(third.r.body.code, "AUTH_LOCKED_OUT");
  assert.ok(Number(third.r.headers["Retry-After"]) >= 1);
});

test("lockout: a locked client is refused even with the correct token; others are not", () => {
  const g = guard();
  for (let i = 0; i < 3; i++) call(g, "1.1.1.1", "Bearer bad");
  const locked = call(g, "1.1.1.1", `Bearer ${TOKEN}`);
  assert.equal(locked.passed, false);
  assert.equal(locked.r.statusCode, 429);
  assert.equal(call(g, "2.2.2.2", `Bearer ${TOKEN}`).passed, true);
});

test("lockout: a successful login clears that client's failure count", () => {
  const g = guard();
  call(g, "1.1.1.1", "Bearer bad"); call(g, "1.1.1.1", "Bearer bad");
  assert.equal(call(g, "1.1.1.1", `Bearer ${TOKEN}`).passed, true);
  assert.equal(call(g, "1.1.1.1", "Bearer bad").r.statusCode, 401, "counter restarted");
});

test("global failure ceiling throttles guessing spread over many addresses, but valid tokens still pass", () => {
  const g = guard();
  let last;
  for (let i = 0; i < 5; i++) last = call(g, `9.9.9.${i}`, "Bearer bad");
  assert.equal(last.r.statusCode, 429);
  assert.equal(call(g, "9.9.9.200", "Bearer bad").r.statusCode, 429);
  assert.equal(call(g, "8.8.8.8", `Bearer ${TOKEN}`).passed, true, "legitimate owner not locked out by a distributed attack");
});

test("lockout does not apply before configuration/HTTPS checks and never leaks the token", () => {
  const g = guard({ configured: false });
  const r = call(g, "1.1.1.1", "Bearer x").r;
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.stringify(r.body).includes(TOKEN), false);
});

// ---------- refresh throttle ----------

function throttle(overrides = {}) {
  return refreshThrottle({
    perSong: createRateLimiter({ windowMs: 300_000, max: 1 }),
    perClient: createRateLimiter({ windowMs: 3_600_000, max: 3 }),
    overall: createRateLimiter({ windowMs: 3_600_000, max: 4, maxKeys: 1 }),
    clientIp: (r) => r.ip,
    ...overrides
  });
}
const refresh = (t, ip, id) => { const r = res(); let passed = false; t({ ip, params: { id } }, r, () => { passed = true; }); return { r, passed }; };

test("refresh throttle: one refresh per song per cooldown, 429 afterwards", () => {
  const t = throttle();
  assert.equal(refresh(t, "1.1.1.1", "7").passed, true);
  const again = refresh(t, "1.1.1.1", "7");
  assert.equal(again.passed, false);
  assert.equal(again.r.statusCode, 429);
  assert.equal(again.r.body.code, "RATE_LIMITED");
  assert.equal(refresh(t, "1.1.1.1", "8").passed, true, "other songs unaffected");
});

test("refresh throttle: per-client and overall caps hold", () => {
  const t = throttle();
  for (const id of ["1", "2", "3"]) assert.equal(refresh(t, "1.1.1.1", id).passed, true);
  assert.equal(refresh(t, "1.1.1.1", "4").r.statusCode, 429, "per-client cap");
  assert.equal(refresh(t, "2.2.2.2", "5").passed, true);
  assert.equal(refresh(t, "3.3.3.3", "6").r.statusCode, 429, "overall cap of 4");
});

test("refresh throttle: a blocked request does not consume other budgets", () => {
  const t = throttle();
  refresh(t, "1.1.1.1", "7");
  for (let i = 0; i < 10; i++) refresh(t, "1.1.1.1", "7"); // all blocked by perSong
  assert.equal(refresh(t, "1.1.1.1", "8").passed, true);
  assert.equal(refresh(t, "1.1.1.1", "9").passed, true);
});

test("chain runs middlewares in order and stops at the first that does not call next", () => {
  const order = [];
  const a = (q, s, n) => { order.push("a"); n(); };
  const b = (q, s) => { order.push("b"); };
  const c = (q, s, n) => { order.push("c"); n(); };
  let reached = false;
  chain(a, b, c)({}, {}, () => { reached = true; });
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(reached, false);
});
