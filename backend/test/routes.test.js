"use strict";

/**
 * Route-level tests. They run the real Express app with a fake database pool
 * (no PostgreSQL needed) but DO require the `express` and `cors` packages:
 *   cd backend && npm install && npm test
 *
 * These are security tests, so missing dependencies FAIL the run (they are never
 * silently skipped). To mark them explicitly BLOCKED on a machine that cannot install
 * dependencies, set MUSICAPP_ALLOW_BLOCKED_ROUTE_TESTS=1: they then run as "todo"
 * (reported, not counted as passes). CI must never set it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

let createApp = null;
let missing = null;
try {
  require.resolve("express");
  require.resolve("cors");
  ({ createApp } = require("../server"));
} catch (error) {
  missing = `express/cors not installed (${error.code || error.message})`;
}

const { loadConfig } = require("../config");

const TOKEN = "k".repeat(48);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const HTTPS = { "X-Forwarded-Proto": "https", "CF-Visitor": '{"scheme":"https"}' }; // as Cloudflare adds; test client connects from loopback

const SONG_ROW = { id: 1, title: "Song", file_path: "a.mp3", duration_seconds: 100, artist: "A", album: "B" };
const LYRIC_ROW = {
  song_id: 1, status: "found", plain_text: "la", synced_lrc: null,
  source: "manual", source_url: "local_editor", fetched_at: null, expires_at: null
};

function makePool({ failQuery = null, failOnSql = null } = {}) {
  const pool = {
    queries: [],
    clients: [],
    async query(sql, params) {
      const text = String(sql).trim().replace(/\s+/g, " ");
      this.queries.push({ text, params });
      if (failQuery) throw failQuery;
      if (/FROM songs s\s+LEFT JOIN artists a/i.test(text)) return { rows: [SONG_ROW] };
      if (/INSERT INTO madineni_song_lyrics/i.test(text)) return { rows: [LYRIC_ROW] };
      if (/INSERT INTO playlists/i.test(text)) return { rows: [{ id: 5, name: "n", description: "", created_at: "x" }] };
      if (/INSERT INTO playlist_songs/i.test(text)) return { rows: [{ playlist_id: 1, song_id: 2 }] };
      if (/DELETE FROM playlist_songs/i.test(text)) return { rows: [{ playlist_id: 1, song_id: 2 }] };
      return { rows: [] };
    },
    async connect() {
      const client = {
        calls: [],
        released: 0,
        async query(sql) {
          const text = String(sql).trim().replace(/\s+/g, " ");
          this.calls.push(text);
          if (failOnSql && text.startsWith(failOnSql)) throw new Error("db exploded: password=hunter2");
          if (text.startsWith("DELETE FROM playlists")) return { rows: [{ id: 1, name: "n" }] };
          return { rows: [] };
        },
        release() { this.released += 1; }
      };
      this.clients.push(client);
      return client;
    }
  };
  return pool;
}

async function withServer(env, pool, run, lyricsExtra = {}) {
  const config = loadConfig({ NODE_ENV: "production", MUSICAPP_PROXY_MODE: "cloudflare", FRONTEND_DIR: "/nonexistent", MUSIC_DIR: "/nonexistent", COVERS_DIR: "/nonexistent", ...env });
  const app = createApp({
    pool,
    config,
    lyricsOptions: { skipSchema: true, localIdentity: async () => "v1", ...lyricsExtra }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (headers, body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body)
});

const WRITES = [
  ["POST", "/api/playlists", { name: "n" }],
  ["POST", "/api/playlists/1/songs", { song_id: 2 }],
  ["DELETE", "/api/playlists/1/songs/2", undefined],
  ["DELETE", "/api/playlists/1", undefined],
  ["POST", "/api/songs/1/lyrics", { plainLyrics: "la" }]
];

function request(base, [method, path, body], headers = {}) {
  return fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const allowBlocked = process.env.MUSICAPP_ALLOW_BLOCKED_ROUTE_TESTS === "1";
const opts = missing
  ? (allowBlocked ? { todo: `BLOCKED: ${missing}` } : { skip: "dependencies missing - see the failing prerequisite test" })
  : {};

test("route-test prerequisites are installed (express, cors)", () => {
  if (allowBlocked) return; // explicitly acknowledged as blocked; the tests below are reported as todo
  assert.equal(missing, null, `Security route tests cannot run: ${missing}. Run "npm ci" in backend/.`);
});
const isWrite = (q) => /^(INSERT|DELETE|UPDATE)/i.test(q.text);

test("every write route answers 503 when MUSICAPP_WRITE_TOKEN is missing", opts, async () => {
  for (const env of [{}, { MUSICAPP_WRITE_TOKEN: "too-short" }, { ADMIN_TOKEN: TOKEN }]) {
    const pool = makePool();
    await withServer(env, pool, async (base) => {
      for (const route of WRITES) {
        const res = await request(base, route, { ...AUTH, ...HTTPS });
        assert.equal(res.status, 503, `${route[0]} ${route[1]}`);
        const body = await res.json();
        assert.equal(body.code, "WRITE_AUTH_UNAVAILABLE");
        assert.equal(JSON.stringify(body).includes(TOKEN), false);
      }
    });
    assert.equal(pool.queries.filter(isWrite).length, 0);
    assert.equal(pool.clients.length, 0);
  }
});

// Root cause of the old 401-vs-429 failure: this test sent 15 bad-token requests (5 routes x 3) from ONE client
// (127.0.0.1) to ONE app whose lockout limit is 10, so the 10th failure correctly locked the client out. The
// limiter is created per createApp() and did not leak between tests. Each route is now probed by its own client
// (CF-Connecting-IP is honoured from the loopback peer in cloudflare mode), keeping every client below the limit.
test("write routes reject missing or invalid tokens with 401 and never touch the database", opts, async () => {
  const pool = makePool();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, pool, async (base) => {
    for (const [i, route] of WRITES.entries()) {
      const client = { ...HTTPS, "CF-Connecting-IP": `203.0.113.${i + 1}` }; // 3 failures per client, limit is 10
      assert.equal((await request(base, route, client)).status, 401);
      assert.equal((await request(base, route, { ...client, Authorization: "Bearer nope" })).status, 401);
      assert.equal((await request(base, route, { ...client, Authorization: TOKEN })).status, 401);
    }
  });
  assert.equal(pool.queries.filter(isWrite).length, 0);
  assert.equal(pool.clients.length, 0);
});

test("invalid authentication answers 401 up to the lockout limit and 429 after it (limit is enforced, not relaxed)", opts, async () => {
  const pool = makePool();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_AUTH_FAIL_MAX: "4" }, pool, async (base) => {
    const client = { ...HTTPS, "CF-Connecting-IP": "203.0.113.50", Authorization: "Bearer wrong" };
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push((await request(base, WRITES[0], client)).status);
    assert.deepEqual(seen, [401, 401, 401, 429, 429, 429]); // 4th failure reaches the max and locks
  });
  assert.equal(pool.queries.filter(isWrite).length, 0);
});

test("lockout is per client: a locked-out client does not lock out others", opts, async () => {
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_AUTH_FAIL_MAX: "3" }, makePool(), async (base) => {
    const a = { ...HTTPS, "CF-Connecting-IP": "203.0.113.60", Authorization: "Bearer wrong" };
    for (let i = 0; i < 3; i++) await request(base, WRITES[0], a);
    assert.equal((await request(base, WRITES[0], a)).status, 429, "client A is locked out");
    const b = { ...HTTPS, "CF-Connecting-IP": "203.0.113.61" };
    assert.equal((await request(base, WRITES[0], { ...b, Authorization: "Bearer wrong" })).status, 401, "client B is not locked");
    const ok = await request(base, WRITES[0], { ...b, ...AUTH });
    assert.ok(![401, 429, 503].includes(ok.status), `client B with the right token is accepted (got ${ok.status})`);
  });
});

test("lockout state is not shared between app instances (no cross-test leakage)", opts, async () => {
  const lock = { ...HTTPS, "CF-Connecting-IP": "203.0.113.70", Authorization: "Bearer wrong" };
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_AUTH_FAIL_MAX: "2" }, makePool(), async (base) => {
    await request(base, WRITES[0], lock);
    assert.equal((await request(base, WRITES[0], lock)).status, 429);
  });
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_AUTH_FAIL_MAX: "2" }, makePool(), async (base) => {
    assert.equal((await request(base, WRITES[0], lock)).status, 401, "a fresh app starts with a clean limiter");
  });
});

test("a valid token over plain HTTP is refused (403) unless HTTPS is explicitly relaxed", opts, async () => {
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, makePool(), async (base) => {
    const res = await request(base, WRITES[0], AUTH);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "HTTPS_REQUIRED");
  });
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_REQUIRE_HTTPS: "false" }, makePool(), async (base) => {
    assert.equal((await request(base, WRITES[0], AUTH)).status, 201);
  });
});

test("valid token over HTTPS succeeds on every write route", opts, async () => {
  const pool = makePool();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, pool, async (base) => {
    const expected = [201, 201, 200, 200, 200];
    for (const [i, route] of WRITES.entries()) {
      const res = await request(base, route, { ...AUTH, ...HTTPS });
      assert.equal(res.status, expected[i], `${route[0]} ${route[1]}`);
      assert.equal((await res.json()).success, true);
    }
  });
});

test("lyrics POST enforces input limits and validation", opts, async () => {
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, makePool(), async (base) => {
    const headers = { ...AUTH, ...HTTPS };
    const post = (id, body) => fetch(`${base}/api/songs/${id}/lyrics`, json(headers, body));

    assert.equal((await post(1, {})).status, 400);
    assert.equal((await post(1, { plainLyrics: "   " })).status, 400);
    assert.equal((await post("abc", { plainLyrics: "x" })).status, 400);
    assert.equal((await post(0, { plainLyrics: "x" })).status, 400);
    assert.equal((await post(1, { plainLyrics: "x".repeat(262144 + 1) })).status, 413);
    assert.equal((await post(1, { syncedLyrics: "[00:01.00]" + "x".repeat(262144) })).status, 413);
    assert.equal((await post(1, { plainLyrics: "x".repeat(262144) })).status, 200);

    const huge = await post(1, { plainLyrics: "x".repeat(600 * 1024) }); // beyond the 512kb body limit
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, "Request body too large");
  });
});

test("GET /api/songs bounds limit/offset and never allows an unbounded query", opts, async () => {
  const pool = makePool();
  await withServer({}, pool, async (base) => {
    const cases = [
      ["", [100, 0]],
      ["?limit=25&offset=50", [25, 50]],
      ["?limit=1000000", [500, 0]],
      ["?limit=0&offset=-3", [100, 0]],
      ["?limit=abc&offset=zz", [100, 0]]
    ];
    for (const [qs, [limit, offset]] of cases) {
      pool.queries.length = 0;
      assert.equal((await fetch(`${base}/api/songs${qs}`)).status, 200);
      const q = pool.queries.find((x) => /FROM songs/i.test(x.text));
      assert.deepEqual(q.params.slice(-2), [limit, offset], qs || "(defaults)");
    }
  });
});

test("search input is escaped so % and _ match literally", opts, async () => {
  const pool = makePool();
  await withServer({}, pool, async (base) => {
    await fetch(`${base}/api/songs?search=${encodeURIComponent("50%_off")}`);
    const q = pool.queries.find((x) => /FROM songs/i.test(x.text));
    assert.equal(q.params[0], "%50\\%\\_off%");
  });
});

test("health is minimal and diagnostics expose no database details", opts, async () => {
  await withServer({ DB_NAME: "music_app" }, makePool(), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { success: true, status: "ok" });
    assert.deepEqual(await (await fetch(`${base}/api/db-test`)).json(), { connected: true });
  });
  const failing = makePool({ failQuery: new Error('password authentication failed for user "musicapp" at 10.0.0.5') });
  await withServer({ DB_NAME: "music_app" }, failing, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { success: false, status: "error" });
    const db = await fetch(`${base}/api/db-test`);
    assert.equal(db.status, 503);
    assert.deepEqual(await db.json(), { connected: false });
  });
});

test("errors are safe: no internals, no stack traces; malformed JSON is a JSON 400", opts, async () => {
  const failing = makePool({ failQuery: new Error('relation "songs" does not exist host=10.0.0.5') });
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, failing, async (base) => {
    for (const path of ["/api/songs", "/api/songs/count", "/api/playlists", "/api/albums", "/api/artists", "/api/stats"]) {
      const res = await fetch(base + path);
      const text = await res.text();
      assert.equal(res.status >= 500, true, path);
      assert.equal(/10\.0\.0\.5|relation|password/i.test(text), false, `${path} leaked: ${text}`);
    }
    const bad = await fetch(`${base}/api/playlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH, ...HTTPS },
      body: "{not json"
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "Invalid request body");
  });
});

test("playlist delete route: failure rolls back on one client and releases it", opts, async () => {
  const pool = makePool({ failOnSql: "DELETE FROM playlists " });
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, pool, async (base) => {
    const res = await fetch(`${base}/api/playlists/1`, { method: "DELETE", headers: { ...AUTH, ...HTTPS } });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(/hunter2|exploded/.test(text), false);
  });
  assert.equal(pool.clients.length, 1);
  const [client] = pool.clients;
  assert.deepEqual(client.calls.map((c) => c.split(" ")[0]), ["BEGIN", "DELETE", "DELETE", "ROLLBACK"]);
  assert.equal(client.calls.includes("COMMIT"), false);
  assert.equal(client.released, 1);
  assert.equal(pool.queries.some((q) => /^DELETE/i.test(q.text)), false);
});

test("CORS: only configured origins receive CORS headers", opts, async () => {
  await withServer({ CORS_ORIGINS: "https://music.example" }, makePool(), async (base) => {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: "https://music.example" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://music.example");
    const bad = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  });
  await withServer({}, makePool(), async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: "https://music.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

// ---------- proxy trust: spoofed headers ----------

test("SPOOF: forged forwarding headers do not satisfy HTTPS in the default (none) mode", opts, async () => {
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_PROXY_MODE: "none" }, makePool(), async (base) => {
    const res = await request(base, WRITES[0], { ...AUTH, ...HTTPS });
    assert.equal(res.status, 403);
  });
});

test("SPOOF: a peer that is not a trusted proxy cannot supply HTTPS headers", opts, async () => {
  // The test client connects from 127.0.0.1; trusting only 10.9.9.9 makes it an untrusted direct client.
  const pool = makePool();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_TRUSTED_PROXIES: "10.9.9.9" }, pool, async (base) => {
    for (const route of WRITES) {
      assert.equal((await request(base, route, { ...AUTH, ...HTTPS })).status, 403, `${route[0]} ${route[1]}`);
    }
  });
  assert.equal(pool.queries.filter(isWrite).length, 0);
});

test("SPOOF: partial or contradictory forwarded headers are refused behind the trusted proxy", opts, async () => {
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, makePool(), async (base) => {
    const cases = [
      { "X-Forwarded-Proto": "https" },                                              // CF-Visitor missing
      { "CF-Visitor": '{"scheme":"https"}' },                                        // X-Forwarded-Proto missing
      { ...HTTPS, "X-Forwarded-Proto": "https, http" },                              // forged first, proxy appended http
      { ...HTTPS, "CF-Visitor": '{"scheme":"http"}' }
    ];
    for (const extra of cases) {
      assert.equal((await request(base, WRITES[0], { ...AUTH, ...extra })).status, 403, JSON.stringify(extra));
    }
    assert.equal((await request(base, WRITES[0], { ...AUTH, ...HTTPS })).status, 201, "correct headers pass");
  });
});

// ---------- failed-authentication lockout ----------

test("repeated bad tokens lock the client out (429), including for the correct token", opts, async () => {
  const pool = makePool();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_AUTH_FAIL_MAX: "3" }, pool, async (base) => {
    const bad = { ...HTTPS, Authorization: "Bearer wrong" };
    assert.equal((await request(base, WRITES[0], bad)).status, 401);
    assert.equal((await request(base, WRITES[0], bad)).status, 401);
    const locked = await request(base, WRITES[0], bad);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    const withGood = await request(base, WRITES[3], { ...AUTH, ...HTTPS });
    assert.equal(withGood.status, 429);
    assert.equal((await withGood.json()).code, "AUTH_LOCKED_OUT");
  });
  assert.equal(pool.queries.filter(isWrite).length, 0);
  assert.equal(pool.clients.length, 0);
});

// ---------- lyrics refresh protection ----------

function lyricsRig() {
  const calls = { provider: 0 };
  return {
    calls,
    extra: {
      localLyrics: async () => null,
      provider: { request: async () => { calls.provider += 1; return null; } }
    }
  };
}
const getLyrics = (base, qs = "", headers = {}) => fetch(`${base}/api/songs/1/lyrics${qs}`, { headers });

test("plain lyrics reads stay open (no token) and still reach the provider on a cache miss", opts, async () => {
  const rig = lyricsRig();
  for (const env of [{}, { MUSICAPP_WRITE_TOKEN: TOKEN }]) {
    rig.calls.provider = 0;
    await withServer(env, makePool(), async (base) => {
      const res = await getLyrics(base);
      assert.equal(res.status, 200);
      assert.ok(rig.calls.provider > 0, "normal reading still performs lookups");
    }, rig.extra);
  }
});

test("explicit refresh without valid auth never reaches the provider or writes", opts, async () => {
  const rig = lyricsRig();
  for (const [env, headers, status] of [
    [{}, { ...AUTH, ...HTTPS }, 503],                                         // no token configured: fail closed
    [{ MUSICAPP_WRITE_TOKEN: TOKEN }, HTTPS, 401],                            // missing credentials
    [{ MUSICAPP_WRITE_TOKEN: TOKEN }, { ...HTTPS, Authorization: "Bearer nope" }, 401],
    [{ MUSICAPP_WRITE_TOKEN: TOKEN }, AUTH, 403]                              // not HTTPS
  ]) {
    const pool = makePool();
    await withServer(env, pool, async (base) => {
      for (const qs of ["?refresh=1", "?refresh=true"]) {
        assert.equal((await getLyrics(base, qs, headers)).status, status, `${qs} ${status}`);
      }
      assert.equal(pool.queries.filter(isWrite).length, 0);
    }, rig.extra);
  }
  assert.equal(rig.calls.provider, 0);
});

test("authorized refresh works once per song per cooldown, then 429", opts, async () => {
  const rig = lyricsRig();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN }, makePool(), async (base) => {
    const first = await getLyrics(base, "?refresh=1", { ...AUTH, ...HTTPS });
    assert.equal(first.status, 200);
    const second = await getLyrics(base, "?refresh=1", { ...AUTH, ...HTTPS });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, "RATE_LIMITED");
    assert.equal((await getLyrics(base)).status, 200, "plain reads unaffected by the refresh limit");
  }, rig.extra);
});

test("refresh budgets: per-client and overall caps apply across songs", opts, async () => {
  const rig = lyricsRig();
  await withServer({ MUSICAPP_WRITE_TOKEN: TOKEN, MUSICAPP_REFRESH_PER_CLIENT_HOUR: "2" }, makePool(), async (base) => {
    const h = { ...AUTH, ...HTTPS };
    assert.equal((await fetch(`${base}/api/songs/1/lyrics?refresh=1`, { headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/songs/2/lyrics?refresh=1`, { headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/songs/3/lyrics?refresh=1`, { headers: h })).status, 429);
  }, rig.extra);
});
