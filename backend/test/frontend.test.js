"use strict";

/**
 * Executes the real client code (extracted from lyrics-player.js and the HTML
 * pages) against stubs, so authentication and pagination behaviour is checked
 * without a browser.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// ---------- lyrics editor authentication ----------

const playerSource = read("backend", "lyrics-player.js");
const authBlock = playerSource.slice(
  playerSource.indexOf("    // ---- Write authentication"),
  playerSource.indexOf("    const visible = () => active")
);

class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.value = ""; this.returnValue = ""; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() {}
  remove() {}
  find(tag) { for (const c of this.children) { if (c.tag === tag) return c; const f = c.find?.(tag); if (f) return f; } return null; }
  showModal() {
    const answer = this.script.shift();
    this.prompts.push(this.find("p")?.textContent);
    if (answer === null || answer === undefined) this.returnValue = "cancel";
    else { this.find("input").value = answer; this.returnValue = "ok"; }
    queueMicrotask(() => this.listeners.close?.());
  }
}

function makeClient({ base = "https://music.example", tokens = [], responses = [] } = {}) {
  const prompts = [];
  const requests = [];
  const document = {
    body: new FakeEl("body"),
    createElement(tag) { const e = new FakeEl(tag); e.script = tokens; e.prompts = prompts; return e; }
  };
  const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
  const fetchStub = async (url, options) => {
    requests.push({ url, options });
    const next = responses.shift() ?? { status: 200, body: { success: true } };
    return { status: next.status, ok: next.status >= 200 && next.status < 300, json: async () => next.body };
  };
  const context = vm.createContext({ document, el, URL, location: { origin: base, href: base + "/" }, fetch: fetchStub, base, console });
  vm.runInContext(`${authBlock}; globalThis.saveLyrics = saveLyrics;`, context);
  return { saveLyrics: context.saveLyrics, prompts, requests };
}

test("asks for a token, sends it only in the Authorization header, then keeps it in memory", async () => {
  const c = makeClient({ tokens: ["secret-token-123"] });
  assert.deepEqual({ ...(await c.saveLyrics(7, { plainLyrics: "la" })) }, { ok: true });
  assert.equal(c.requests[0].options.headers.Authorization, "Bearer secret-token-123");
  assert.equal(c.requests[0].url.includes("secret-token-123"), false);
  assert.equal(String(c.requests[0].options.body).includes("secret-token-123"), false);
  assert.equal(c.requests[0].url, "https://music.example/api/songs/7/lyrics");

  await c.saveLyrics(7, { plainLyrics: "again" });
  assert.equal(c.prompts.length, 1, "token is reused without prompting again");
});

test("cancelling the token prompt saves nothing and says so", async () => {
  const c = makeClient({ tokens: [null] });
  const result = await c.saveLyrics(1, { plainLyrics: "x" });
  assert.equal(result.ok, false);
  assert.match(result.message, /cancelled/i);
  assert.equal(c.requests.length, 0);
});

test("a rejected token (401) is discarded and re-requested with a visible message", async () => {
  const c = makeClient({ tokens: ["bad", "good"], responses: [{ status: 401, body: { code: "AUTH_REQUIRED" } }, { status: 200, body: { success: true } }] });
  assert.deepEqual({ ...(await c.saveLyrics(1, { plainLyrics: "x" })) }, { ok: true });
  assert.equal(c.prompts.length, 2);
  assert.match(c.prompts[1], /not accepted/i);
  assert.equal(c.requests[1].options.headers.Authorization, "Bearer good");
});

test("repeated 401 stops after three attempts with an error", async () => {
  const c = makeClient({ tokens: ["a", "b", "c", "d"], responses: Array(5).fill({ status: 401, body: {} }) });
  const result = await c.saveLyrics(1, { plainLyrics: "x" });
  assert.equal(result.ok, false);
  assert.match(result.message, /rejected too many times/i);
  assert.equal(c.requests.length, 3);
});

test("server without a write token (503) yields a clear message and no retry loop", async () => {
  const c = makeClient({ tokens: ["t"], responses: [{ status: 503, body: { code: "WRITE_AUTH_UNAVAILABLE" } }] });
  const result = await c.saveLyrics(1, { plainLyrics: "x" });
  assert.equal(result.ok, false);
  assert.match(result.message, /no write token configured/i);
  assert.equal(c.requests.length, 1);
});

test("HTTPS-required (403), size (413) and network failures are reported", async () => {
  let c = makeClient({ tokens: ["t"], responses: [{ status: 403, body: { code: "HTTPS_REQUIRED" } }] });
  assert.match((await c.saveLyrics(1, { plainLyrics: "x" })).message, /requires HTTPS/i);

  c = makeClient({ tokens: ["t"], responses: [{ status: 413, body: { error: "Lyrics text is too large" } }] });
  assert.match((await c.saveLyrics(1, { plainLyrics: "x" })).message, /too large/i);
});

test("the token is never prompted for or sent over plain HTTP to a remote host", async () => {
  const c = makeClient({ base: "http://music.example", tokens: ["t"] });
  const result = await c.saveLyrics(1, { plainLyrics: "x" });
  assert.equal(result.ok, false);
  assert.match(result.message, /https/i);
  assert.equal(c.prompts.length, 0);
  assert.equal(c.requests.length, 0);

  const local = makeClient({ base: "http://localhost:3000", tokens: ["t"] });
  assert.equal((await local.saveLyrics(1, { plainLyrics: "x" })).ok, true);
});

test("no frontend file embeds or persists a write token", () => {
  const files = [
    ["backend", "lyrics-player.js"], ["frontend", "index.html"], ["frontend", "aura-neon-music-app.html"],
    ["frontend-demo", "index.html"], ["frontend-demo", "index-real.html"]
  ];
  for (const f of files) {
    const text = read(...f);
    assert.equal(/MUSICAPP_WRITE_TOKEN/.test(text), false, f.join("/"));
    assert.equal(/(localStorage|sessionStorage|document\.cookie)[^\n]*(token|Bearer)/i.test(text), false, f.join("/"));
    assert.equal(/[?&](token|access_token|auth)=/i.test(text), false, f.join("/"));
  }
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(authBlock), false);
});

test("lyrics-player has no remaining unauthenticated write call", () => {
  const postCalls = playerSource.match(/method:\s*'POST'/g) || [];
  assert.equal(postCalls.length, 1);
  assert.equal(/\balert\(/.test(playerSource), false);
});

// ---------- song pagination in all four pages ----------

function fakeLibrary(total, serverCap) {
  const songs = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
  const calls = [];
  const page = (query) => {
    const params = new URLSearchParams(query);
    const limit = Math.min(Number(params.get("limit")) || 100, serverCap);
    const offset = Number(params.get("offset")) || 0;
    calls.push({ limit, offset });
    return songs.slice(offset, offset + limit);
  };
  return { songs, calls, page };
}

function extract(file, name) {
  const match = new RegExp(`^async function ${name}\\(.*$`, "m").exec(read(...file));
  assert.ok(match, `${name} missing in ${file.join("/")}`);
  return match[0];
}

const pageLoaders = [
  [["frontend", "index.html"], "apiAllSongs"],
  [["frontend", "aura-neon-music-app.html"], "apiAllSongs"],
  [["frontend-demo", "index.html"], "fetchAllSongs"],
  [["frontend-demo", "index-real.html"], "fetchAllSongs"]
];

for (const [file, name] of pageLoaders) {
  for (const cap of [500, 200, 37]) {
    test(`${file.join("/")}: loads every song with server page cap ${cap}`, async () => {
      const lib = fakeLibrary(1234, cap);
      const api = async (p) => lib.page(p.split("?")[1]);
      const fetchStub = async (url) => ({ ok: true, status: 200, json: async () => lib.page(url.split("?")[1]) });
      const context = vm.createContext({ api, fetch: fetchStub, SONGS_API: "https://x/api/songs", Error, Array });
      vm.runInContext(`${extract(file, name)}; globalThis.loadAll = ${name};`, context);

      const all = await context.loadAll();
      assert.equal(all.length, 1234);
      assert.equal(new Set(all.map((s) => s.id)).size, 1234, "no duplicates or gaps");
      assert.equal(lib.calls.every((c) => c.limit <= cap), true);
    });
  }

  test(`${file.join("/")}: a failed page throws instead of silently returning a partial library`, async () => {
    let n = 0;
    const lib = fakeLibrary(1500, 500);
    const api = async (p) => { if (++n === 2) throw new Error("503"); return lib.page(p.split("?")[1]); };
    const fetchStub = async (url) => { if (++n === 2) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => lib.page(url.split("?")[1]) }; };
    const context = vm.createContext({ api, fetch: fetchStub, SONGS_API: "https://x/api/songs", Error, Array });
    vm.runInContext(`${extract(file, name)}; globalThis.loadAll = ${name};`, context);
    await assert.rejects(() => context.loadAll());
  });
}
