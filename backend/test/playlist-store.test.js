"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deletePlaylist } = require("../playlist-store");

/**
 * Fake pool that hands out distinct clients so we can prove every statement
 * of one transaction goes through the same checked-out client.
 */
function makePool({ failOn = null, rollbackFails = false, deletedRow = { id: 7, name: "Mix" } } = {}) {
  const pool = {
    clients: [],
    poolQueries: [],
    query(sql) { this.poolQueries.push(sql); return Promise.reject(new Error("pool.query must not be used")); },
    async connect() {
      const client = {
        id: this.clients.length + 1,
        calls: [],
        releases: [],
        async query(sql, params) {
          const text = String(sql).trim().replace(/\s+/g, " ");
          this.calls.push(text);
          if (failOn && text.startsWith(failOn)) throw new Error("boom: password=hunter2");
          if (rollbackFails && text === "ROLLBACK") throw new Error("connection lost");
          if (text.startsWith("DELETE FROM playlists")) return { rows: deletedRow ? [deletedRow] : [] };
          return { rows: [] };
        },
        release(arg) { this.releases.push(arg); }
      };
      this.clients.push(client);
      return client;
    }
  };
  return pool;
}

test("success: BEGIN, both deletes and COMMIT use one client; released once", async () => {
  const pool = makePool();
  const row = await deletePlaylist(pool, 7);

  assert.deepEqual(row, { id: 7, name: "Mix" });
  assert.equal(pool.clients.length, 1);
  assert.deepEqual(pool.clients[0].calls, [
    "BEGIN",
    "DELETE FROM playlist_songs WHERE playlist_id = $1",
    "DELETE FROM playlists WHERE id = $1 RETURNING id, name",
    "COMMIT"
  ]);
  assert.equal(pool.poolQueries.length, 0);
  assert.deepEqual(pool.clients[0].releases, [false]);
});

test("failure on the second DELETE rolls back on the same client and releases", async () => {
  const pool = makePool({ failOn: "DELETE FROM playlists " });

  await assert.rejects(() => deletePlaylist(pool, 7), /boom/);

  const client = pool.clients[0];
  assert.deepEqual(client.calls.map((c) => c.split(" ")[0]), ["BEGIN", "DELETE", "DELETE", "ROLLBACK"]);
  assert.equal(client.calls.includes("COMMIT"), false);
  assert.equal(pool.clients.length, 1);
  assert.equal(pool.poolQueries.length, 0);
  assert.equal(client.releases.length, 1);
});

test("failure on the first DELETE rolls back and releases", async () => {
  const pool = makePool({ failOn: "DELETE FROM playlist_songs" });
  await assert.rejects(() => deletePlaylist(pool, 7), /boom/);
  assert.equal(pool.clients[0].calls.at(-1), "ROLLBACK");
  assert.equal(pool.clients[0].releases.length, 1);
});

test("failure on COMMIT triggers ROLLBACK and release", async () => {
  const pool = makePool({ failOn: "COMMIT" });
  await assert.rejects(() => deletePlaylist(pool, 7), /boom/);
  assert.deepEqual(pool.clients[0].calls.slice(-2), ["COMMIT", "ROLLBACK"]);
  assert.equal(pool.clients[0].releases.length, 1);
});

test("if ROLLBACK itself fails, the original error is thrown and the connection is discarded", async () => {
  const original = console.error;
  console.error = () => {};
  const pool = makePool({ failOn: "DELETE FROM playlists ", rollbackFails: true });
  await assert.rejects(() => deletePlaylist(pool, 7), /boom/);
  console.error = original;
  assert.deepEqual(pool.clients[0].releases, [true]);
});

test("missing playlist returns null and still commits and releases", async () => {
  const pool = makePool({ deletedRow: null });
  assert.equal(await deletePlaylist(pool, 999), null);
  assert.equal(pool.clients[0].calls.at(-1), "COMMIT");
  assert.equal(pool.clients[0].releases.length, 1);
});

test("a failed connect() propagates and checks out nothing", async () => {
  const pool = { connect: async () => { throw new Error("pool exhausted"); } };
  await assert.rejects(() => deletePlaylist(pool, 1), /pool exhausted/);
});
