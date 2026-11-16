"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Safety guard for the integration tests. The tests may only ever touch a
 * throwaway PostgreSQL on this machine whose database name starts with
 * "musicapp_test". Anything else is refused BEFORE a connection is attempted.
 * Error messages never include the connection string (it may hold a password).
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function assertDisposableDatabaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("MUSICAPP_TEST_DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("test database URL must use the postgres:// scheme");
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("refusing to run: the test database host must be localhost, 127.0.0.1 or [::1]");
  }
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr") || url.searchParams.has("service")) {
    throw new Error("refusing to run: host overrides are not allowed in the test database URL");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^musicapp_test[a-z0-9_]*$/.test(database)) {
    throw new Error('refusing to run: the test database name must start with "musicapp_test"');
  }
  return { database };
}

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "..", "fixtures", "db-test-schema.sql"), "utf8");

/**
 * Create a unique schema in the disposable database, install the synthetic
 * tables in it, and return a pool whose every connection uses only that schema.
 */
async function createDisposableSchema(Pool, databaseUrl) {
  assertDisposableDatabaseUrl(databaseUrl);
  const schema = `t_${crypto.randomBytes(6).toString("hex")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  pool.on("error", () => {});
  pool.on("connect", (client) => {
    client.query(`SET search_path TO ${schema}`).catch(() => {});
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(SCHEMA_SQL);
  const check = await pool.query("SELECT current_schema() AS s");
  if (check.rows[0].s !== schema) {
    await pool.end();
    throw new Error("test connection is not confined to its private schema; aborting");
  }
  return {
    pool,
    schema,
    async drop() {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  };
}

module.exports = { assertDisposableDatabaseUrl, createDisposableSchema };
