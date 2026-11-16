const express = require("express");
const cors = require("cors");
const path = require("path");
const { loadConfig } = require("./config");
const {
  parsePagination,
  requireWriteAuth,
  refreshThrottle,
  chain,
  buildCorsOptions,
  jsonErrorHandler
} = require("./http-utils");
const { buildSongsQuery } = require("./songs-query");
const { createProxyTrust } = require("./proxy");
const { createRateLimiter } = require("./rate-limit");
const { deletePlaylist } = require("./playlist-store");

/**
 * Build the Express app. The database pool and configuration are injected so
 * the routes can be tested without a live database.
 */
function createApp({ pool, config, lyricsOptions = {} }) {

const app = express();
app.disable("x-powered-by");

// Forwarded headers are never trusted via Express "trust proxy"; see proxy.js.
const proxy = createProxyTrust({
  mode: config.proxyMode,
  trustedProxies: config.trustedProxies
});

const FRONTEND_DIR = config.frontendDir;
const MUSIC_DIR = config.musicDir;
const COVERS_DIR = config.coversDir;
const EXPOSE_ERROR_DETAILS = config.exposeErrorDetails;

// Fail-closed: without a valid MUSICAPP_WRITE_TOKEN every write route answers 503.
const writeGuard = requireWriteAuth({
  token: config.writeToken,
  configured: config.writeAuthConfigured,
  requireHttps: config.requireHttps,
  isSecure: proxy.isSecure,
  clientIp: proxy.clientIp,
  failLimiter: createRateLimiter({ windowMs: config.authFailWindowMs, max: config.authFailMax }),
  globalFailLimiter: createRateLimiter({
    windowMs: config.authFailWindowMs,
    max: config.authFailGlobalMax,
    maxKeys: 1
  })
});

// Explicit lyrics refresh (?refresh=1) costs a provider lookup and a database
// write: it needs the write token and is throttled per song, client and overall.
const hour = 60 * 60 * 1000;
const refreshGuard = chain(
  writeGuard,
  refreshThrottle({
    perSong: createRateLimiter({ windowMs: config.refreshSongCooldownMs, max: 1 }),
    perClient: createRateLimiter({ windowMs: hour, max: config.refreshPerClientHour }),
    overall: createRateLimiter({ windowMs: hour, max: config.refreshOverallHour, maxKeys: 1 }),
    clientIp: proxy.clientIp
  })
);

// Only configured origins receive CORS headers. CORS is not authentication.
app.use(cors(buildCorsOptions(config.corsOrigins)));
app.use(express.json({ limit: "512kb" }));

app.use(express.static(FRONTEND_DIR));
app.use("/music", express.static(MUSIC_DIR));
app.use("/covers", express.static(COVERS_DIR));

/* =========================
ROOT
========================= */

// MADINENI LYRICS START
require("./madineni-lyrics.cjs").mount(app, pool, {musicDir:MUSIC_DIR, ...lyricsOptions, writeGuard, refreshGuard});
// MADINENI LYRICS END


app.get("/", (req, res) => {
res.sendFile(
path.join(FRONTEND_DIR, "index.html")
);
});

/* =========================
HEALTH
========================= */

app.get("/api/health", async (req, res) => {

try {

await pool.query("SELECT 1");

res.json({ success: true, status: "ok" });

} catch (error) {

console.error(
  "Health check error:",
  error.message
);

res.status(503).json({ success: false, status: "error" });

}

});

// Kept for compatibility; exposes no database name, host or timestamp.
app.get("/api/db-test", async (req, res) => {

try {

await pool.query("SELECT 1");

res.json({ connected: true });

} catch (error) {

console.error(
  "Database connection error:",
  error.message
);

res.status(503).json({ connected: false });

}

});

/* =========================
SONGS
========================= */

app.get("/api/songs", async (req, res) => {

try {

const search =
  typeof req.query.search === "string"
    ? req.query.search.trim()
    : "";

const artist =
  typeof req.query.artist === "string"
    ? req.query.artist.trim()
    : "";

const album =
  typeof req.query.album === "string"
    ? req.query.album.trim()
    : "";

const { limit, offset } =
  parsePagination(req.query, {
    defaultSize: config.defaultPageSize,
    maxSize: config.maxPageSize
  });

const query = buildSongsQuery({ search, artist, album, limit, offset });

const result =
  await pool.query(query.text, query.values);

res.json(result.rows);

} catch (error) {

console.error(
  "Songs API error:",
  error.message
);

res.status(500).json({
  error: "Unable to load songs",
  details: EXPOSE_ERROR_DETAILS ? error.message : undefined
});

}

});

/* =========================
SONG COUNT
========================= */

app.get("/api/songs/count", async (req, res) => {

try {

const result =
  await pool.query(
    "SELECT COUNT(*) AS count FROM songs"
  );

res.json({
  success: true,
  count: Number(result.rows[0].count)
});

} catch (error) {

res.status(500).json({
  success: false,
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
});

}

});

/* =========================
SINGLE SONG
========================= */

app.get("/api/songs/:id", async (req, res) => {

try {

const id =
  Number.parseInt(
    req.params.id,
    10
  );

if (!Number.isInteger(id)) {

  return res.status(400).json({
    success: false,
    error: "Invalid song ID"
  });

}

const result =
  await pool.query(
    `
    SELECT
      songs.id,
      songs.title,
      songs.artist_id,
      artists.name AS artist,
      songs.album_id,
      albums.title AS album,
      songs.track_number,
      songs.duration_seconds,
      songs.file_path,
      songs.file_format,
      songs.file_size,
      songs.created_at

    FROM songs

    LEFT JOIN artists
      ON songs.artist_id = artists.id

    LEFT JOIN albums
      ON songs.album_id = albums.id

    WHERE songs.id = $1
    `,
    [id]
  );

if (!result.rows.length) {

  return res.status(404).json({
    success: false,
    error: "Song not found"
  });

}

res.json({
  success: true,
  data: result.rows[0]
});

} catch (error) {

console.error(
  "Single song API error:",
  error.message
);

res.status(500).json({
  success: false,
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
});

}

});

/* =========================
ARTISTS
========================= */

app.get("/api/artists", async (req, res) => {

try {

const result =
  await pool.query(
    `
    SELECT
      artists.id,
      artists.name,
      COUNT(songs.id) AS song_count

    FROM artists

    LEFT JOIN songs
      ON songs.artist_id = artists.id

    GROUP BY
      artists.id,
      artists.name

    ORDER BY
      artists.name ASC
    `
  );

res.json(result.rows);

} catch (error) {

console.error(
  "Artists API error:",
  error.message
);

res.status(500).json({
  success: false,
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
});

}

});

/* =========================
ALBUMS
========================= */

app.get("/api/albums", async (req, res) => {

try {

const result =
  await pool.query(
    `
    SELECT
      albums.id,
      albums.title,
      albums.artist_id,
      artists.name AS artist,
      albums.year,
      albums.cover_path,
      COUNT(songs.id) AS song_count,
      COALESCE(NULLIF(albums.cover_path, ''), '/covers/' || MIN(songs.id) || '.jpg') AS cover_art

    FROM albums

    LEFT JOIN artists
      ON albums.artist_id = artists.id

    LEFT JOIN songs
      ON songs.album_id = albums.id

    GROUP BY
      albums.id,
      albums.title,
      albums.artist_id,
      artists.name,
      albums.year,
      albums.cover_path

    HAVING COUNT(songs.id) > 0

    ORDER BY
      albums.title ASC
    `
  );

res.json(result.rows);

} catch (error) {

console.error(
  "Albums API error:",
  error.message
);

res.status(500).json({
  success: false,
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
});

}

});

/* =========================
STATS
========================= */

app.get("/api/stats", async (req, res) => {

try {

const result =
  await pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM songs) AS songs,
      (SELECT COUNT(*) FROM artists) AS artists,
      (SELECT COUNT(*) FROM albums) AS albums,
      (SELECT COUNT(*) FROM playlists) AS playlists
    `
  );

res.json({
  success: true,
  data: {
    songs: Number(result.rows[0].songs),
    artists: Number(result.rows[0].artists),
    albums: Number(result.rows[0].albums),
    playlists: Number(result.rows[0].playlists)
  }
});

} catch (error) {

console.error(
  "Stats API error:",
  error.message
);

res.status(500).json({
  success: false,
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
});

}

});

/* =========================
PLAYLISTS
========================= */

app.get("/api/playlists", async (req, res) => {

try {

const result =
  await pool.query(
    `
    SELECT
      p.id,
      p.name,
      p.description,
      p.created_at,
      COUNT(ps.song_id) AS song_count

    FROM playlists p

    LEFT JOIN playlist_songs ps
      ON p.id = ps.playlist_id

    GROUP BY
      p.id,
      p.name,
      p.description,
      p.created_at

    ORDER BY
      p.id ASC
    `
  );

res.json({
  success: true,
  data: result.rows
});

} catch (error) {

console.error(
  "Playlists API error:",
  error.message
);

res.status(500).json({
  success: false,
  error: "Unable to load playlists",
  details: EXPOSE_ERROR_DETAILS ? error.message : undefined
});

}

});

/* =========================
CREATE PLAYLIST
========================= */

app.post("/api/playlists", writeGuard, async (req, res) => {

try {

const name =
  typeof req.body.name === "string"
    ? req.body.name.trim()
    : "";

const description =
  typeof req.body.description === "string"
    ? req.body.description.trim()
    : "";

if (!name) {

  return res.status(400).json({
    success: false,
    error: "Playlist name is required"
  });

}

const result =
  await pool.query(
    `
    INSERT INTO playlists
      (name, description)

    VALUES
      ($1, $2)

    RETURNING
      id,
      name,
      description,
      created_at
    `,
    [name, description]
  );

res.status(201).json({
  success: true,
  data: result.rows[0]
});

} catch (error) {

console.error(
  "Create playlist error:",
  error.message
);

res.status(500).json({
  success: false,
  error: "Unable to create playlist",
  details: EXPOSE_ERROR_DETAILS ? error.message : undefined
});

}

});

/* =========================
PLAYLIST SONGS
========================= */

app.get(
"/api/playlists/:id/songs",
async (req, res) => {

try {

  const playlistId =
    Number.parseInt(
      req.params.id,
      10
    );

  if (!Number.isInteger(playlistId)) {

    return res.status(400).json({
      success: false,
      error: "Invalid playlist ID"
    });

  }

  const result =
    await pool.query(
      `
      SELECT
        songs.id,
        songs.title,
        artists.name AS artist,
        albums.title AS album,
        songs.file_path,
        songs.duration_seconds,
        songs.file_format

      FROM playlist_songs ps

      JOIN songs
        ON songs.id = ps.song_id

      LEFT JOIN artists
        ON songs.artist_id = artists.id

      LEFT JOIN albums
        ON songs.album_id = albums.id

      WHERE ps.playlist_id = $1

      ORDER BY ps.id ASC
      `,
      [playlistId]
    );

  res.json({
    success: true,
    data: result.rows
  });

} catch (error) {

  console.error(
    "Playlist songs API error:",
    error.message
  );

  res.status(500).json({
    success: false,
    error: "Unable to load playlist songs",
    details: EXPOSE_ERROR_DETAILS ? error.message : undefined
  });

}

}
);

/* =========================
ADD SONG TO PLAYLIST
========================= */

app.post(
"/api/playlists/:id/songs",
writeGuard,
async (req, res) => {

try {

  const playlistId =
    Number.parseInt(
      req.params.id,
      10
    );

  const songId =
    Number.parseInt(
      req.body.song_id,
      10
    );

  if (
    !Number.isInteger(playlistId) ||
    !Number.isInteger(songId)
  ) {

    return res.status(400).json({
      success: false,
      error:
        "Valid playlist ID and song ID are required"
    });

  }

  const result =
    await pool.query(
      `
      INSERT INTO playlist_songs
        (playlist_id, song_id)

      VALUES
        ($1, $2)

      ON CONFLICT DO NOTHING

      RETURNING
        playlist_id,
        song_id
      `,
      [playlistId, songId]
    );

  res.status(201).json({
    success: true,
    added: result.rows.length > 0,
    data: result.rows[0] || null
  });

} catch (error) {

  if (error.code === "23503") {
    return res.status(404).json({
      success: false,
      error: "Playlist or song not found"
    });
  }

  console.error(
    "Add playlist song error:",
    error.message
  );

  res.status(500).json({
    success: false,
    error:
      "Unable to add song to playlist",
    details: EXPOSE_ERROR_DETAILS ? error.message : undefined
  });

}

}
);

/* =========================
REMOVE SONG FROM PLAYLIST
========================= */

app.delete(
"/api/playlists/:id/songs/:songId",
writeGuard,
async (req, res) => {

try {

  const playlistId =
    Number.parseInt(
      req.params.id,
      10
    );

  const songId =
    Number.parseInt(
      req.params.songId,
      10
    );

  if (
    !Number.isInteger(playlistId) ||
    !Number.isInteger(songId)
  ) {

    return res.status(400).json({
      success: false,
      error:
        "Invalid playlist ID or song ID"
    });

  }

  const result =
    await pool.query(
      `
      DELETE FROM playlist_songs

      WHERE playlist_id = $1
        AND song_id = $2

      RETURNING
        playlist_id,
        song_id
      `,
      [playlistId, songId]
    );

  res.json({
    success: true,
    removed: result.rows.length > 0,
    data: result.rows[0] || null
  });

} catch (error) {

  console.error(
    "Remove playlist song error:",
    error.message
  );

  res.status(500).json({
    success: false,
    error:
      "Unable to remove song from playlist",
    details: EXPOSE_ERROR_DETAILS ? error.message : undefined
  });

}

}
);

/* =========================
DELETE PLAYLIST
========================= */

app.delete(
"/api/playlists/:id",
writeGuard,
async (req, res) => {

try {

  const playlistId =
    Number.parseInt(
      req.params.id,
      10
    );

  if (!Number.isInteger(playlistId)) {

    return res.status(400).json({
      success: false,
      error: "Invalid playlist ID"
    });

  }

  const deleted = await deletePlaylist(pool, playlistId);

  if (!deleted) {

    return res.status(404).json({
      success: false,
      error: "Playlist not found"
    });

  }

  res.json({
    success: true,
    data: deleted
  });

} catch (error) {

  console.error(
    "Delete playlist error:",
    error.message
  );

  res.status(500).json({
    success: false,
    error:
      "Unable to delete playlist",
    details: EXPOSE_ERROR_DETAILS ? error.message : undefined
  });

}

}
);

/* =========================
404
========================= */

app.use((req, res) => {

res.status(404).json({
success: false,
error: "API endpoint not found",
path: req.path
});

});

app.use(jsonErrorHandler(EXPOSE_ERROR_DETAILS));

return app;

}

/* =========================
SERVER
========================= */

function start() {

  require("dotenv").config({
    path: process.env.ENV_FILE || "/opt/musicapp/app/config/.env"
  });

  const { Pool } = require("pg");
  const config = loadConfig(process.env);

  if (!config.writeAuthConfigured) {
    console.warn(
      "WARNING: MUSICAPP_WRITE_TOKEN is " +
      (config.writeTokenTooShort ? "shorter than 32 characters" : "not set") +
      ". Playlist and lyrics write routes are DISABLED (503)."
    );
  }

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  createApp({ pool, config }).listen(
    config.port,
    "0.0.0.0",
    () => {
      console.log("Music app API listening on port " + config.port);
    }
  );

}

if (require.main === module) {
  start();
}

module.exports = { createApp };
