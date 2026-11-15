"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeLike,
  safeEqual,
  requireWriteAuth,
  errorBody,
  jsonErrorHandler
} = require("../http-utils");

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function fakeReq(authorization) {
  return { get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined) };
}

test("escapeLike escapes %, _ and backslash", () => {
  assert.equal(escapeLike("100%_done\\"), "100\\%\\_done\\\\");
  assert.equal(escapeLike("plain"), "plain");
});

test("safeEqual compares equal and unequal strings of any length", () => {
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "secreT"), false);
  assert.equal(safeEqual("a", "a-much-longer-value"), false);
});

test("write guard passes through when no token is configured", () => {
  let called = false;
  requireWriteAuth("")(fakeReq(), fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test("write guard rejects missing or wrong tokens with 401", () => {
  for (const header of [undefined, "", "Bearer wrong", "Basic secret", "Bearer"]) {
    const res = fakeRes();
    let called = false;
    requireWriteAuth("secret")(fakeReq(header), res, () => { called = true; });
    assert.equal(called, false, `header ${header} must not pass`);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  }
});

test("write guard accepts the correct bearer token", () => {
  let called = false;
  requireWriteAuth("secret")(fakeReq("Bearer secret"), fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

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

  const origError = console.error;
  console.error = () => {};
  const boom = fakeRes();
  handler(new Error("secret db host"), {}, boom, () => {});
  console.error = origError;
  assert.equal(boom.statusCode, 500);
  assert.equal(JSON.stringify(boom.body).includes("secret db host"), false);
});
