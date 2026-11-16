"use strict";

/**
 * Integration tests: the REAL Express app + the REAL pg driver + a DISPOSABLE
 * PostgreSQL holding SYNTHETIC rows only.
 *
 *   MUSICAPP_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/musicapp_test_x \
 *     npm run test:integration
 *
 * Safety: test/helpers/disposable-db.js refuses any host except loopback and any
 * database whose name does not start with "musicapp_test". Every test works in its
 * own freshly created schema and drops it afterwards. No production data, no
 * migrations, no external services.
 *
 * Like the route tests these are security tests, so missing prerequisites FAIL
 * (never skip). MUSICAPP_ALLOW_BLOCKED_ROUTE_TESTS=1 marks them todo (blocked, not
 * counted as passes) on a machine that cannot install dependencies or run PostgreSQL.
 * CI must never set it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

let Pool = null;
let createApp = null;
let missing = null;
try {
  ({ Pool } = require("pg"));
  require.resolve("express");
  require.resolve("cors");
  ({ createApp } = require("../../server"));
} catch (error) {
  missing = `pg/express/cors not installed (${error.code || error.message})`;
}

const { loadConfig } = require("../../config");
const { ensureSchema } = require("../../madineni-lyrics.cjs");
const { assertDisposableDatabaseUrl, createDisposableSchema } = require("../helpers/disposable-db");

const DATABASE_URL = process.env.MUSICAPP_TEST_DATABASE_URL || "";
const allowBlocked = process.env.MUSICAPP_ALLOW_BLOCKED_ROUTE_TESTS === "1";

let blocked = missing;
if (!blocked && !DATABASE_URL) blocked = "MUSICAPP_TEST_DATABASE_URL is not set";
if (!blocked) {
  try {
    assertDisposableDatabaseUrl(DATABASE_URL);
  } catch (error) {
    blocked = error.message;
  }
}
const opts = blocked ? (allowBlocked ? { todo: `BLOCKED: ${blocked}` } : { skip: "prerequisites missing - see the failing prerequisite test" }) : {};

test("integration prerequisites are available (pg, express, a disposable local test database)", () => {
  if (allowBlocked) return; // explicitly acknowledged as blocked; the tests below are reported as todo
  assert.equal(blocked, null, `Integration tests cannot run: ${blocked}`);
});

const TOKEN = "t".repeat(48);
const WRONG = "w".repeat(48);
const HTTPS = { "X-Forwarded-Proto": "https", "CF-Visitor": '{"scheme":"https"}' };
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`; // distinct client per request: lockout is not under test here

/** Seed: three songs; playlists Alpha {s1,s2}, Beta {s1,s2,s3}, Gamma {}; lyrics for song 2 only. */
async function seed(pool) {
  await pool.query(`INSERT INTO artists (name) VALUES ('Synthetic Artist A'), ('Synthetic Artist B')`);
  await pool.query(`INSERT INTO albums (title) VALUES ('Synthetic Album One')`);
  await pool.query(`INSERT INTO songs (title, artist_id, album_id, duration_seconds, file_path) VALUES
    ('Synthetic Song 1', 1, 1, 100, 'synthetic/s1.mp3'),
    ('Synthetic Song 2', 2, 1, 110, 'synthetic/s2.mp3'),
    ('Synthetic Song 3', 1, NULL, 120, 'synthetic/s3.mp3')`);
  await pool.query(`INSERT INTO playlists (name, description) VALUES
    ('Synthetic Alpha', 'a'), ('Synthetic Beta', 'b'), ('Synthetic Gamma', 'g')`);
  await pool.query(`INSERT INTO playlist_songs (playlist_id, song_id) VALUES (1,1),(1,2),(2,1),(2,2),(2,3)`);
  await ensureSchema(pool); // the real lyrics DDL from madineni-lyrics.cjs
  await pool.query(`INSERT INTO madineni_song_lyrics (song_id, fingerprint, status, plain_text, source, source_url)
    VALUES (2, 'seed-fingerprint', 'found', 'seed lyrics for song two', 'manual', 'local_editor')`);
}

const TABLES = ["artists", "albums", "songs", "playlists", "playlist_songs", "madineni_song_lyrics"];
async function snapshot(pool) {
  const out = {};
  for (const table of TABLES) {
    const order = table === "playlist_songs" ? "playlist_id, song_id" : table === "madineni_song_lyrics" ? "song_id" : "id";
    out[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  }
  return out;
}

async function withEnv(env, run) {
  const db = await createDisposableSchema(Pool, DATABASE_URL);
  let server;
  try {
    await seed(db.pool);
    const config = loadConfig({
      NODE_ENV: "production",
      MUSICAPP_PROXY_MODE: "cloudflare",
      FRONTEND_DIR: "/nonexistent",
      MUSIC_DIR: "/nonexistent",
      COVERS_DIR: "/nonexistent",
      ...env
    });
    const app = createApp({ pool: db.pool, config, lyricsOptions: { localIdentity: async () => "v1" } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return await run({ base, pool: db.pool, snap: () => snapshot(db.pool) });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.drop();
  }
}
const withServer = (run) => withEnv({ MUSICAPP_WRITE_TOKEN: TOKEN }, run);

function call(base, method, path, body, headers = {}) {
  return fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
const authed = { Authorization: `Bearer ${TOKEN}`, ...HTTPS };
const links = async (pool, playlistId) =>
  (await pool.query("SELECT song_id FROM playlist_songs WHERE playlist_id=$1 ORDER BY song_id", [playlistId])).rows.map((r) => Number(r.song_id));

const WRITES = [
  ["POST", "/api/playlists", { name: "Intruder" }],
  ["POST", "/api/playlists/1/songs", { song_id: 3 }],
  ["DELETE", "/api/playlists/1/songs/1", undefined],
  ["DELETE", "/api/playlists/1", undefined],
  ["POST", "/api/songs/1/lyrics", { plainLyrics: "intruder lyrics" }]
];

test("unauthorised writes change nothing in the database", opts, async () => {
  await withServer(async ({ base, snap }) => {
    const before = await snap();
    const attempts = [
      ["no credentials (over HTTPS)", { ...HTTPS }, 401, undefined],
      ["wrong token", { Authorization: `Bearer ${WRONG}`, ...HTTPS }, 401, undefined],
      ["wrong scheme (Basic)", { Authorization: `Basic ${TOKEN}`, ...HTTPS }, 401, undefined],
      ["token only in the query string", { ...HTTPS }, 401, `?token=${TOKEN}`],
      ["token only in the JSON body", { ...HTTPS }, 401, "BODY"],
      ["correct token over plain HTTP", { Authorization: `Bearer ${TOKEN}` }, 403, undefined]
    ];
    for (const [label, headers, expected, extra] of attempts) {
      for (const [method, path, body] of WRITES) {
        const url = extra && extra !== "BODY" ? path + extra : path;
        const payload = extra === "BODY" ? { ...(body || {}), token: TOKEN, admin_token: TOKEN } : body;
        const res = await call(base, method, url, payload, headers);
        assert.equal(res.status, expected, `${label}: ${method} ${path}`);
        const text = await res.text();
        assert.equal(text.includes(TOKEN), false, "the response must never echo the token");
      }
    }
    assert.deepEqual(await snap(), before, "database contents must be byte-for-byte unchanged");
  });
});

test("with no valid MUSICAPP_WRITE_TOKEN configured every write answers 503 and changes nothing", opts, async () => {
  for (const env of [{}, { MUSICAPP_WRITE_TOKEN: "too-short" }]) {
    await withEnv(env, async ({ base, snap }) => {
      const before = await snap();
      for (const [method, path, body] of WRITES) {
        const res = await call(base, method, path, body, authed);
        assert.equal(res.status, 503, `${method} ${path}`);
      }
      assert.deepEqual(await snap(), before);
    });
  }
});

test("authorised playlist writes work and persist", opts, async () => {
  await withServer(async ({ base, pool }) => {
    const created = await call(base, "POST", "/api/playlists", { name: "  New synthetic list ", description: " d " }, authed);
    assert.equal(created.status, 201);
    const row = (await created.json()).data;
    assert.equal(row.name, "New synthetic list");
    const stored = (await pool.query("SELECT name, description FROM playlists WHERE id=$1", [row.id])).rows[0];
    assert.deepEqual(stored, { name: "New synthetic list", description: "d" });

    const add = await call(base, "POST", `/api/playlists/${row.id}/songs`, { song_id: 3 }, authed);
    assert.equal(add.status, 201);
    assert.equal((await add.json()).added, true);
    const again = await call(base, "POST", `/api/playlists/${row.id}/songs`, { song_id: 3 }, authed);
    assert.equal((await again.json()).added, false, "adding the same song twice must not create a second link");
    assert.deepEqual(await links(pool, row.id), [3]);

    const missingSong = await call(base, "POST", `/api/playlists/${row.id}/songs`, { song_id: 9999 }, authed);
    assert.equal(missingSong.status, 404);
    const missingList = await call(base, "POST", "/api/playlists/9999/songs", { song_id: 1 }, authed);
    assert.equal(missingList.status, 404);
    assert.deepEqual(await links(pool, row.id), [3]);
    assert.equal((await links(pool, 9999)).length, 0);

    const removed = await call(base, "DELETE", `/api/playlists/${row.id}/songs/3`, undefined, authed);
    assert.equal((await removed.json()).removed, true);
    const removedAgain = await call(base, "DELETE", `/api/playlists/${row.id}/songs/3`, undefined, authed);
    assert.equal((await removedAgain.json()).removed, false);
    assert.deepEqual(await links(pool, row.id), []);

    const deleted = await call(base, "DELETE", `/api/playlists/${row.id}`, undefined, authed);
    assert.equal(deleted.status, 200);
    assert.equal((await pool.query("SELECT 1 FROM playlists WHERE id=$1", [row.id])).rowCount, 0);
    const deletedAgain = await call(base, "DELETE", `/api/playlists/${row.id}`, undefined, authed);
    assert.equal(deletedAgain.status, 404);
  });
});

test("authorised lyrics write inserts, then updates the same row, and never touches other songs", opts, async () => {
  await withServer(async ({ base, pool }) => {
    const otherBefore = (await pool.query("SELECT * FROM madineni_song_lyrics WHERE song_id=2")).rows;
    assert.equal(otherBefore.length, 1);

    const first = await call(base, "POST", "/api/songs/1/lyrics", { plainLyrics: "  first synthetic line  " }, authed);
    assert.equal(first.status, 200);
    let rows = (await pool.query("SELECT * FROM madineni_song_lyrics WHERE song_id=1")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plain_text, "first synthetic line");
    assert.equal(rows[0].source, "manual");
    assert.equal(rows[0].status, "found");

    const second = await call(base, "POST", "/api/songs/1/lyrics", { plainLyrics: "second synthetic line", syncedLyrics: "[00:01.00]x" }, authed);
    assert.equal(second.status, 200);
    rows = (await pool.query("SELECT * FROM madineni_song_lyrics WHERE song_id=1")).rows;
    assert.equal(rows.length, 1, "an edit updates the existing row");
    assert.equal(rows[0].plain_text, "second synthetic line");
    assert.equal(rows[0].synced_lrc, "[00:01.00]x");

    assert.deepEqual((await pool.query("SELECT * FROM madineni_song_lyrics WHERE song_id=2")).rows, otherBefore, "another song's lyrics are untouched");

    const noSong = await call(base, "POST", "/api/songs/9999/lyrics", { plainLyrics: "x" }, authed);
    assert.equal(noSong.status, 404);
    assert.equal((await pool.query("SELECT 1 FROM madineni_song_lyrics WHERE song_id=9999")).rowCount, 0);
    const bad = await call(base, "POST", "/api/songs/abc/lyrics", { plainLyrics: "x" }, authed);
    assert.equal(bad.status, 400);
    const empty = await call(base, "POST", "/api/songs/1/lyrics", { plainLyrics: "   " }, authed);
    assert.equal(empty.status, 400);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM madineni_song_lyrics")).rows[0].n, 2);
  });
});

test("one playlist operation cannot affect another playlist", opts, async () => {
  await withServer(async ({ base, pool, snap }) => {
    const otherPlaylists = async () => ({ beta: await links(pool, 2), gamma: await links(pool, 3) });
    const baseline = await otherPlaylists();
    assert.deepEqual(baseline, { beta: [1, 2, 3], gamma: [] });

    // Removing a song that is also in Beta leaves Beta alone.
    assert.equal((await call(base, "DELETE", "/api/playlists/1/songs/1", undefined, authed)).status, 200);
    assert.deepEqual(await links(pool, 1), [2]);
    assert.deepEqual(await otherPlaylists(), baseline);

    // Adding to Alpha leaves the others alone.
    assert.equal((await call(base, "POST", "/api/playlists/1/songs", { song_id: 3 }, authed)).status, 201);
    assert.deepEqual(await links(pool, 1), [2, 3]);
    assert.deepEqual(await otherPlaylists(), baseline);

    // Deleting Alpha removes only Alpha and its links; songs and lyrics survive.
    const before = await snap();
    assert.equal((await call(base, "DELETE", "/api/playlists/1", undefined, authed)).status, 200);
    const after = await snap();
    assert.deepEqual(await links(pool, 1), []);
    assert.deepEqual(await otherPlaylists(), baseline);
    assert.deepEqual(after.songs, before.songs);
    assert.deepEqual(after.madineni_song_lyrics, before.madineni_song_lyrics);
    assert.deepEqual(after.playlists.map((p) => Number(p.id)), [2, 3]);

    // Deleting a playlist that does not exist changes nothing at all.
    const frozen = await snap();
    assert.equal((await call(base, "DELETE", "/api/playlists/9999", undefined, authed)).status, 404);
    assert.deepEqual(await snap(), frozen);
  });
});

test("playlist delete is atomic: a failure after the link delete rolls it back", opts, async () => {
  await withServer(async ({ base, pool, snap }) => {
    await pool.query(`CREATE FUNCTION synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure marker'; END $$`);
    await pool.query(`CREATE TRIGGER synthetic_fail_delete BEFORE DELETE ON playlists FOR EACH ROW WHEN (OLD.id = 1) EXECUTE FUNCTION synthetic_fail()`);
    const before = await snap();

    const res = await call(base, "DELETE", "/api/playlists/1", undefined, authed);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text.includes("synthetic failure marker"), false, "database error text must not reach the client in production");
    assert.deepEqual(await snap(), before, "the link rows deleted before the failure must have been rolled back");
    assert.deepEqual(await links(pool, 1), [1, 2]);

    // The pooled connection was released: later writes still work.
    assert.equal((await call(base, "POST", "/api/playlists", { name: "after failure" }, authed)).status, 201);
    assert.equal(pool.waitingCount, 0);
  });
});

test("concurrent identical adds create exactly one link and no server error", opts, async () => {
  await withServer(async ({ base, pool }) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => call(base, "POST", "/api/playlists/3/songs", { song_id: 3 }, authed))
    );
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201]);
    const added = await Promise.all(results.map(async (r) => (await r.json()).added));
    assert.equal(added.filter(Boolean).length, 1, "exactly one request inserts the link");
    assert.deepEqual(await links(pool, 3), [3]);
  });
});
