'use strict';

const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {newDb, DataType} = require('pg-mem');
const {createApp} = require('../server.js');
const {getConfig, loadEnvironment} = require('../config.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'madineni-reliability-'));
const musicDir = path.join(root, 'music');
const coversDir = path.join(root, 'covers');
fs.mkdirSync(musicDir);
fs.mkdirSync(coversDir);
const audioFile = path.join(musicDir, 'test-track.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-codec:a', 'libmp3lame', audioFile]);
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64',
  '-frames:v', '1', path.join(coversDir, 'album-1.jpg')]);
after(() => fs.rmSync(root, {recursive: true, force: true}));

async function fixture(t, env = {}) {
  // Test-only catalog: these types do not claim to describe the live schema.
  const db = newDb();
  // pg-mem omits PostgreSQL's built-in NULLIF; supply its text semantics.
  db.public.registerFunction({name: 'nullif', args: [DataType.text, DataType.text],
    returns: DataType.text, allowNullArguments: true, implementation: (a, b) => a === b ? null : a});
  db.public.registerOperator({operator: '||', left: DataType.text, right: DataType.integer,
    returns: DataType.text, implementation: (a, b) => a + String(b)});
  db.public.none([
    'CREATE TABLE artists (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
    'CREATE TABLE albums (id SERIAL PRIMARY KEY, title TEXT, artist_id INTEGER REFERENCES artists(id), year INTEGER, cover_path TEXT);',
    'CREATE TABLE songs (id SERIAL PRIMARY KEY, title TEXT, artist_id INTEGER REFERENCES artists(id), album_id INTEGER REFERENCES albums(id),',
    'track_number INTEGER, duration_seconds INTEGER, file_path TEXT, file_format TEXT, file_size INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());',
    'CREATE TABLE playlists (id SERIAL PRIMARY KEY, name TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW());',
    'CREATE TABLE playlist_songs (id SERIAL PRIMARY KEY, playlist_id INTEGER REFERENCES playlists(id), song_id INTEGER REFERENCES songs(id), UNIQUE(playlist_id,song_id));',
    "INSERT INTO artists VALUES (1,'Test Artist');",
    "INSERT INTO albums VALUES (1,'Test Album',1,2026,'/covers/album-1.jpg');",
  ].join('\n'));
  db.public.none('INSERT INTO songs (id,title,artist_id,album_id,track_number,duration_seconds,file_path,file_format,file_size) VALUES ' +
    Array.from({length: 601}, (_, i) => '(' + (i + 1) + ",'Track " + (i + 1) +
      "',1,1," + (i + 1) + ",1,'test-track.mp3','mp3',5000)").join(',') + ';');
  const {Pool} = db.adapters.createPg();
  const pool = new Pool();
  const config = getConfig({MUSIC_DIR: musicDir, COVERS_DIR: coversDir,
    FRONTEND_DIR: path.resolve(__dirname, '../../frontend'), ...env});
  const appInstance = createApp({pool, config, lyricsOptions: {
    localIdentity: async () => 'fixture',
    localLyrics: async () => ({plainLyrics: 'Fixture line', syncedLyrics: '[00:00.00]Fixture line', source: 'local'}),
  }});
  const server = appInstance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  return {base: 'http://127.0.0.1:' + server.address().port, pool, config};
}

function playerLoader(filename, request, base) {
  const source = fs.readFileSync(path.resolve(__dirname, '../..', filename), 'utf8');
  const match = source.match(/\/\/ MADINENI SONG PAGINATION START([\s\S]*?)\/\/ MADINENI SONG PAGINATION END/);
  assert.ok(match, filename + ' contains the song loader');
  return vm.runInNewContext(match[1] + '\nloadAllSongs', {
    fetch: request, URL, location: {href: base + '/index.html'},
  });
}

test('legacy native requests still receive the complete catalog by default', async t => {
  const {base} = await fixture(t);
  const response = await fetch(base + '/api/songs');
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.equal(rows.length, 601);
  assert.equal(rows.at(-1).id, 601);
  assert.equal(response.headers.get('X-Songs-Next-Offset'), null);
});

test('bounded mode defaults to 50 and caps each requested page at 500', async t => {
  const {base} = await fixture(t, {SONGS_PAGINATION_ENABLED: 'true'});
  const first = await fetch(base + '/api/songs');
  assert.equal((await first.json()).length, 50);
  assert.equal(first.headers.get('X-Songs-Next-Offset'), '50');
  const large = await fetch(base + '/api/songs?limit=1000000&offset=0');
  assert.equal((await large.json()).length, 500);
  assert.equal(large.headers.get('X-Songs-Page-Limit'), '500');
  const last = await fetch(base + '/api/songs?limit=500&offset=500');
  const rows = await last.json();
  assert.equal(rows.length, 101);
  assert.equal(rows[0].id, 501);
  assert.equal(last.headers.get('X-Songs-Next-Offset'), null);
});

for (const filename of ['frontend/index.html', 'frontend/aura-neon-music-app.html',
  'frontend-demo/index.html', 'frontend-demo/index-real.html']) {
  test(filename + ' loads every page without missing or duplicating songs', async t => {
    const {base} = await fixture(t, {SONGS_PAGINATION_ENABLED: 'true'});
    const rows = await playerLoader(filename, fetch, base)(base + '/api/songs');
    assert.deepEqual(Array.from(rows, row => row.id), Array.from({length: 601}, (_, i) => i + 1));
  });
}

test('the browser loader also works with older servers that omit paging headers', async () => {
  const expected = Array.from({length: 601}, (_, i) => ({id: i + 1}));
  const loader = playerLoader('frontend/index.html', async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return new Response(JSON.stringify(expected.slice(offset, offset + 500)), {status: 200});
  }, 'https://music.example');
  assert.deepEqual(Array.from(await loader('/api/songs'), row => row.id), expected.map(row => row.id));
});

test('a later-page error is reported instead of silently returning a partial library', async () => {
  let calls = 0;
  const loader = playerLoader('frontend/index.html', async () => {
    if (++calls === 2) return new Response('{}', {status: 429});
    return new Response(JSON.stringify(Array.from({length: 500}, (_, i) => ({id: i + 1}))));
  }, 'https://music.example');
  await assert.rejects(loader('/api/songs'), /429/);
});

test('artwork and search results stay consistent across list and single-song endpoints', async t => {
  const {base} = await fixture(t);
  const list = await (await fetch(base + '/api/songs?limit=1')).json();
  const single = await (await fetch(base + '/api/songs/1')).json();
  assert.equal(single.data.cover_art, list[0].cover_art);
  assert.equal(single.data.cover_art, '/covers/album-1.jpg');
  const filtered = await (await fetch(base + '/api/songs?search=Track%20601')).json();
  assert.deepEqual(filtered.map(row => row.id), [601]);
  assert.equal((await fetch(base + '/api/songs?search=' + 'x'.repeat(201))).status, 400);
});

test('website origins are allowed, other origins receive no permission, and native HTTP remains usable', async t => {
  const {base} = await fixture(t);
  for (const origin of [base, 'https://madinenimusic.madineni.xyz']) {
    const response = await fetch(base + '/api/songs?limit=1', {headers: {Origin: origin}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  const foreign = await fetch(base + '/api/songs?limit=1', {headers: {Origin: 'https://untrusted.example'}});
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await fetch(base + '/api/songs?limit=1')).status, 200);
  const preflight = await fetch(base + '/api/playlists', {method: 'OPTIONS',
    headers: {Origin: base, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}});
  assert.equal(preflight.status, 204);
});

test('security headers preserve existing inline player controls and local HTTP', async t => {
  const {base} = await fixture(t);
  const response = await fetch(base + '/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('onclick='));
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('Content-Security-Policy'), null);
  assert.equal(response.headers.get('Strict-Transport-Security'), null);
  assert.equal(response.headers.get('X-Powered-By'), null);
});

test('API throttling leaves health checks, artwork and audio seeking available', async t => {
  const {base} = await fixture(t, {API_RATE_LIMIT: '1'});
  assert.equal((await fetch(base + '/api/songs?limit=1')).status, 200);
  const limited = await fetch(base + '/api/songs?limit=1');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/covers/album-1.jpg')).status, 200);
  const seek = await fetch(base + '/music/test-track.mp3', {headers: {Range: 'bytes=0-99'}});
  assert.equal(seek.status, 206);
  assert.equal((await seek.arrayBuffer()).byteLength, 100);
  assert.ok(seek.headers.get('Content-Range').startsWith('bytes 0-99/'));
  assert.equal(seek.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  const streamed = Buffer.from(await (await fetch(base + '/music/test-track.mp3')).arrayBuffer());
  const downloaded = path.join(root, 'downloaded.mp3');
  fs.writeFileSync(downloaded, streamed);
  execFileSync('ffmpeg', ['-v', 'error', '-i', downloaded, '-f', 'null', '-']);
});

test('a trusted local proxy applies limits separately to different clients', async t => {
  const {base} = await fixture(t, {API_RATE_LIMIT: '1'});
  const request = ip => fetch(base + '/api/songs?limit=1', {headers: {'X-Forwarded-For': ip}});
  assert.equal((await request('203.0.113.1')).status, 200);
  assert.equal((await request('203.0.113.2')).status, 200);
  assert.equal((await request('203.0.113.1')).status, 429);
});

test('valid playlist creation works and invalid or oversized bodies are rejected', async t => {
  const {base} = await fixture(t);
  const request = body => fetch(base + '/api/playlists', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body)});
  const created = await request({name: '  Test Playlist  ', description: 'Fixture'});
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.name, 'Test Playlist');
  assert.equal((await request({name: 'x'.repeat(121)})).status, 400);
  assert.equal((await request({name: 'Valid', description: 'x'.repeat(2001)})).status, 400);
  assert.equal((await request('{invalid')).status, 400);
  assert.equal((await request({name: 'x'.repeat(40000)})).status, 413);
});

test('lyrics still resolve locally, cache, and retain their existing JSON response', async t => {
  const {base} = await fixture(t, {LYRICS_RATE_LIMIT: '2'});
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/api/songs/1/lyrics');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.status, 'found');
    assert.equal(payload.data.lines[0].text, 'Fixture line');
  }
  assert.equal((await fetch(base + '/api/songs/1/lyrics')).status, 429);
  const status = await (await fetch(base + '/api/lyrics/status')).json();
  assert.equal(status.counts.found, 1);
});

test('all player inline JavaScript is valid after updating the song loaders', () => {
  for (const filename of ['frontend/index.html', 'frontend/aura-neon-music-app.html',
    'frontend-demo/index.html', 'frontend-demo/index-real.html']) {
    const html = fs.readFileSync(path.resolve(__dirname, '../..', filename), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new vm.Script(match[1], {filename});
    }
  }
});

test('configuration permits custom directories while preserving existing environment variables', () => {
  const config = getConfig({PORT: '3100', MUSIC_DIR: musicDir, COVERS_DIR: coversDir});
  assert.equal(config.port, 3100);
  assert.equal(config.musicDir, musicDir);
  assert.equal(config.coversDir, coversDir);
  assert.equal(getConfig({PORT: 'bad'}).port, 3000);
  const names = ['ENV_FILE', 'DB_HOST', 'DB_NAME'];
  const before = Object.fromEntries(names.map(key => [key, process.env[key]]));
  try {
    process.env.ENV_FILE = path.join(root, 'test.env');
    process.env.DB_HOST = 'already-set';
    delete process.env.DB_NAME;
    fs.writeFileSync(process.env.ENV_FILE, 'DB_HOST=file-value\nDB_NAME=fixture_db\n');
    loadEnvironment();
    assert.equal(process.env.DB_HOST, 'already-set');
    assert.equal(process.env.DB_NAME, 'fixture_db');
  } finally {
    for (const key of names) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
