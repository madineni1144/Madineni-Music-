"use strict";

/**
 * Executes the REAL query text from songs-query.js in SQLite (ILIKE -> LIKE,
 * $n -> ?n). SQLite is not PostgreSQL, so this proves the query's paging
 * logic (ORDER BY + LIMIT/OFFSET + LEFT JOINs), not PostgreSQL planner
 * behaviour. Requires Node >= 22.13 (node:sqlite); a missing module FAILS.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { buildSongsQuery } = require("../songs-query");
const { parsePagination } = require("../http-utils");

const TOTAL = 1234;

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE albums  (id INTEGER PRIMARY KEY, title TEXT, cover_path TEXT);
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, album_id INTEGER,
      track_number INTEGER, duration_seconds INTEGER, file_path TEXT,
      file_format TEXT, file_size INTEGER, created_at TEXT
    );
  `);
  for (let a = 1; a <= 40; a++) db.prepare("INSERT INTO artists VALUES (?, ?)").run(a, `Artist ${a % 5}`); // duplicate names
  for (let a = 1; a <= 60; a++) db.prepare("INSERT INTO albums VALUES (?, ?, ?)").run(a, `Album ${a % 4}`, a % 2 ? "" : `/covers/a${a}.jpg`);
  const insert = db.prepare("INSERT INTO songs VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= TOTAL; i++) {
    insert.run(
      i, `Song ${i % 7}`,                       // many identical titles
      i % 9 === 0 ? null : (i % 40) + 1,        // some songs without an artist
      i % 11 === 0 ? null : (i % 60) + 1,       // some songs without an album
      i % 12, 180, `s${i}.mp3`, "mp3", 1000, "2026-01-01T00:00:00Z" // identical timestamps
    );
  }
  return db;
}

function run(db, params) {
  const { text, values } = buildSongsQuery(params);
  const sql = text.replace(/ILIKE/g, "LIKE").replace(/\$(\d+)/g, "?$1");
  return db.prepare(sql).all(...values);
}

function pageAll(db, pageSize, filters = {}) {
  const ids = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const rows = run(db, { ...filters, limit: pageSize, offset: ids.length });
    if (!rows.length) return ids;
    ids.push(...rows.map((r) => r.id));
  }
  throw new Error("paging did not terminate");
}

const db = makeDb();
const expectedAll = Array.from({ length: TOTAL }, (_, i) => i + 1);

test("ORDER BY uses only the unique songs.id key", () => {
  const { text } = buildSongsQuery({ limit: 10, offset: 0 });
  const orders = text.match(/ORDER BY[^\n]*/g);
  assert.deepEqual(orders, ["ORDER BY songs.id ASC"]);
});

for (const size of [1, 7, 37, 100, 500, 1000, 5000]) {
  test(`unchanged data, page size ${size}: every song exactly once, in id order`, () => {
    const ids = pageAll(db, size);
    assert.equal(ids.length, TOTAL, "no omissions or extras");
    assert.equal(new Set(ids).size, TOTAL, "no duplicates");
    assert.deepEqual(ids, expectedAll);
  });
}

test("songs with NULL artist/album (LEFT JOIN) are included and not duplicated", () => {
  const ids = pageAll(db, 100);
  const withoutArtist = db.prepare("SELECT COUNT(*) c FROM songs WHERE artist_id IS NULL").get().c;
  assert.ok(withoutArtist > 0);
  const rows = run(db, { limit: 5000, offset: 0 });
  assert.equal(rows.filter((r) => r.artist === null).length, withoutArtist);
  assert.equal(ids.length, TOTAL);
});

test("filtered paging (many identical titles) equals the unpaged filtered result", () => {
  for (const filters of [{ search: "Song 3" }, { artist: "Artist 2" }, { album: "Album 1" }, { search: "Artist 4", album: "Album 2" }]) {
    const all = run(db, { ...filters, limit: 100_000, offset: 0 }).map((r) => r.id);
    assert.ok(all.length > 0, JSON.stringify(filters));
    for (const size of [1, 13, 100]) {
      assert.deepEqual(pageAll(db, size, filters), all, `${JSON.stringify(filters)} size ${size}`);
    }
    assert.equal(new Set(all).size, all.length);
  }
});

test("different page sizes produce identical sequences", () => {
  assert.deepEqual(pageAll(db, 37), pageAll(db, 500));
});

test("repeated reads of the same page return the same rows", () => {
  const a = run(db, { limit: 50, offset: 300 }).map((r) => r.id);
  const b = run(db, { limit: 50, offset: 300 }).map((r) => r.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, expectedAll.slice(300, 350));
});

test("API-level bounds: the largest page the server will build is maxSize", () => {
  const { limit } = parsePagination({ limit: "1000000" }, { defaultSize: 100, maxSize: 500 });
  assert.equal(limit, 500);
  assert.equal(run(db, { limit, offset: 0 }).length, 500);
});
