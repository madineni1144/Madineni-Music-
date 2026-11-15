"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeLike,
  safeEqual,
  parsePagination,
  requireWriteAuth,
  buildCorsOptions,
  errorBody,
  jsonErrorHandler
} = require("../http-utils");
const { loadConfig } = require("../config");

const TOKEN = "t".repeat(40);

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function fakeReq({ authorization, secure = true } = {}) {
  return {
    secure,
    get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined)
  };
}

function guard(overrides = {}) {
  return requireWriteAuth({ token: TOKEN, configured: true, requireHttps: true, ...overrides });
}

test("escapeLike escapes %, _ and backslash", () => {
  assert.equal(escapeLike("100%_done\\"), "100\\%\\_done\\\\");
  assert.equal(escapeLike("plain"), "plain");
});

test("safeEqual handles equal, different and unequal-length strings", () => {
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "secreT"), false);
  assert.equal(safeEqual("a", "a-much-longer-value"), false);
});

// ---- write guard: fail closed ----

test("guard fails closed (503) when no token is configured", () => {
  for (const opts of [{ token: "", configured: false }, { token: TOKEN, configured: false }, { token: "", configured: true }]) {
    const res = fakeRes();
    let called = false;
    requireWriteAuth({ requireHttps: false, ...opts })(
      fakeReq({ authorization: `Bearer ${TOKEN}` }), res, () => { called = true; }
    );
    assert.equal(called, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "WRITE_AUTH_UNAVAILABLE");
  }
});

test("guard called with no options at all is closed, not open", () => {
  const res = fakeRes();
  let called = false;
  requireWriteAuth()(fakeReq(), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
});

test("guard rejects missing or invalid credentials with 401", () => {
  for (const header of [undefined, "", "Bearer wrong", `Basic ${TOKEN}`, "Bearer", `Bearer ${TOKEN}x`]) {
    const res = fakeRes();
    let called = false;
    guard()(fakeReq({ authorization: header }), res, () => { called = true; });
    assert.equal(called, false, `header ${header} must not pass`);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "AUTH_REQUIRED");
  }
});

test("guard accepts the correct bearer token over HTTPS", () => {
  let called = false;
  guard()(fakeReq({ authorization: `Bearer ${TOKEN}` }), fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("guard refuses valid token over plain HTTP when HTTPS is required", () => {
  const res = fakeRes();
  let called = false;
  guard()(fakeReq({ authorization: `Bearer ${TOKEN}`, secure: false }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "HTTPS_REQUIRED");
});

test("guard allows HTTP only when HTTPS requirement is explicitly disabled", () => {
  let called = false;
  guard({ requireHttps: false })(fakeReq({ authorization: `Bearer ${TOKEN}`, secure: false }), fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("guard responses never contain the configured token", () => {
  for (const [opts, req] of [
    [{ configured: false }, fakeReq({ authorization: `Bearer ${TOKEN}` })],
    [{}, fakeReq({ authorization: "Bearer nope" })],
    [{}, fakeReq({ authorization: `Bearer ${TOKEN}`, secure: false })]
  ]) {
    const res = fakeRes();
    guard(opts)(req, res, () => {});
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
  }
});

// ---- config ----

test("loadConfig: missing, short and valid tokens", () => {
  assert.equal(loadConfig({}).writeAuthConfigured, false);

  const short = loadConfig({ MUSICAPP_WRITE_TOKEN: "short" });
  assert.equal(short.writeAuthConfigured, false);
  assert.equal(short.writeTokenTooShort, true);

  const ok = loadConfig({ MUSICAPP_WRITE_TOKEN: ` ${TOKEN} ` });
  assert.equal(ok.writeAuthConfigured, true);
  assert.equal(ok.writeToken, TOKEN);
});

test("loadConfig: old ADMIN_TOKEN name does not enable writes", () => {
  assert.equal(loadConfig({ ADMIN_TOKEN: TOKEN }).writeAuthConfigured, false);
});

test("loadConfig: documented defaults are preserved", () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.frontendDir, "/opt/musicapp/app/frontend");
  assert.equal(c.musicDir, "/opt/musicapp/music/Songs");
  assert.equal(c.coversDir, "/opt/musicapp/covers");
  assert.equal(c.requireHttps, true);
  assert.deepEqual(c.corsOrigins, []);
  assert.equal(c.defaultPageSize, 100);
  assert.equal(c.maxPageSize, 500);
});

test("loadConfig: error details never exposed in production", () => {
  assert.equal(loadConfig({ EXPOSE_ERROR_DETAILS: "true" }).exposeErrorDetails, true);
  assert.equal(loadConfig({ EXPOSE_ERROR_DETAILS: "true", NODE_ENV: "production" }).exposeErrorDetails, false);
});

test("loadConfig: default page size never exceeds max page size", () => {
  const c = loadConfig({ MUSICAPP_MAX_PAGE_SIZE: "50", MUSICAPP_DEFAULT_PAGE_SIZE: "200" });
  assert.equal(c.maxPageSize, 50);
  assert.equal(c.defaultPageSize, 50);
});

// ---- pagination ----

test("parsePagination applies defaults and clamps to the maximum", () => {
  const opts = { defaultSize: 100, maxSize: 500 };
  assert.deepEqual(parsePagination({}, opts), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "25", offset: "50" }, opts), { limit: 25, offset: 50 });
  assert.deepEqual(parsePagination({ limit: "1000000" }, opts), { limit: 500, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "0" }, opts), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "-5", offset: "-1" }, opts), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "abc", offset: "xyz" }, opts), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination(undefined, opts), { limit: 100, offset: 0 });
});

// ---- CORS ----

test("CORS: only configured origins are allowed; no Origin header is unaffected", () => {
  const { origin } = buildCorsOptions(["https://music.example"]);
  const decide = (o) => { let r; origin(o, (_e, allow) => { r = allow; }); return r; };
  assert.equal(decide("https://music.example"), true);
  assert.equal(decide("https://evil.example"), false);
  assert.equal(decide(undefined), true);
  const none = buildCorsOptions([]).origin;
  let r; none("https://music.example", (_e, allow) => { r = allow; });
  assert.equal(r, false);
});

// ---- safe errors ----

test("errorBody hides internal details unless exposure is enabled", () => {
  const err = new Error("relation \"songs\" does not exist");
  assert.deepEqual(errorBody("Unable", err, false), { success: false, error: "Unable" });
  assert.equal(errorBody("Unable", err, true).details, err.message);
});

test("jsonErrorHandler maps body-parser errors and hides 500 details", () => {
  const handler = jsonErrorHandler(false);

  const bad = fakeRes();
  handler({ status: 400, message: "Unexpected token" }, {}, bad, () => {});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "Invalid request body");
  assert.equal(bad.body.details, undefined);

  const big = fakeRes();
  handler({ status: 413, message: "too large" }, {}, big, () => {});
  assert.equal(big.statusCode, 413);

  const original = console.error;
  console.error = () => {};
  const boom = fakeRes();
  handler(new Error("secret db host"), {}, boom, () => {});
  console.error = original;
  assert.equal(boom.statusCode, 500);
  assert.equal(JSON.stringify(boom.body).includes("secret db host"), false);
});
