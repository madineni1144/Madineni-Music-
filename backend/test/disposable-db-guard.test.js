"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertDisposableDatabaseUrl } = require("./helpers/disposable-db");

test("the integration-test guard accepts only a local musicapp_test database", () => {
  for (const ok of [
    "postgres://u@localhost:5432/musicapp_test",
    "postgres://u:p@127.0.0.1:54329/musicapp_test_ci",
    "postgresql://u@[::1]/musicapp_test_local"
  ]) assert.doesNotThrow(() => assertDisposableDatabaseUrl(ok), ok);

  for (const bad of [
    "postgres://u@db.example.com/musicapp_test",        // remote host
    "postgres://u@10.0.0.5/musicapp_test",               // private network host
    "postgres://u@localhost/musicapp",                    // production-looking name
    "postgres://u@localhost/postgres",
    "postgres://u@localhost/prod_musicapp_test",          // must START with the prefix
    "postgres://u@localhost/musicapp_test?host=db.example.com", // host override
    "mysql://u@localhost/musicapp_test",
    "not a url",
    ""
  ]) assert.throws(() => assertDisposableDatabaseUrl(bad), Error, bad);
});

test("guard errors never echo the connection string or its password", () => {
  const secret = "s3cr3t-pass-value";
  try {
    assertDisposableDatabaseUrl(`postgres://user:${secret}@db.example.com/prod`);
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes("db.example.com"), false);
  }
});
