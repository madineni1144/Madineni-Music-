const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const { Pool } = require("pg");
const { loadEnvironment, getConfig } = require("./config.cjs");

loadEnvironment();

function createApp({ pool: existingPool, config = getConfig(), lyricsOptions = {} } = {}) {
const app = express();

const FRONTEND_DIR = config.frontendDir;
const MUSIC_DIR = config.musicDir;
const COVERS_DIR = config.coversDir;

app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.use(helmet({
  // Existing players use inline scripts and onclick handlers.
  contentSecurityPolicy: false,
  // Artwork/audio may be used by a separate web or native client.
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // Keep the existing local HTTP and LAN development workflow.
  strictTransportSecurity: false,
}));
app.use(cors((req, done) => {
  const origin = req.get("origin");
  let allowed = !origin || config.corsOrigins.includes(origin);
  if (origin) {
    try {
      const source = new URL(origin);
      const target = new URL(req.protocol + "://" + req.get("host"));
      allowed ||= ["http:", "https:"].includes(source.protocol) && source.host === target.host;
    } catch { /* An invalid Origin receives no CORS permission. */ }
  }
  done(null, {
    origin: allowed,
    exposedHeaders: ["Accept-Ranges", "Content-Range", "Content-Length", "X-Songs-Page-Limit", "X-Songs-Next-Offset"],
  });
}));
app.use(express.json({ limit: "32kb" }));

app.use(express.static(FRONTEND_DIR));
app.use("/music", express.static(MUSIC_DIR, { maxAge: config.musicCacheMaxAge, acceptRanges: true }));
app.use("/covers", express.static(COVERS_DIR));

// Audio Range requests and artwork are deliberately outside API rate limits.
app.use("/api", rateLimit({
  windowMs: 60000, limit: config.apiRateLimit,
  standardHeaders: "draft-7", legacyHeaders: false,
  skip: req => req.path === "/health" || req.method === "OPTIONS",
  message: { success: false, error: "Too many API requests. Please try again shortly." },
}));
app.use("/api/songs/:id/lyrics", rateLimit({
  windowMs: 60000, limit: config.lyricsRateLimit,
  standardHeaders: "draft-7", legacyHeaders: false,
  skip: req => req.method === "OPTIONS",
  message: { success: false, error: "Too many lyrics requests. Please try again shortly." },
}));

const pool = existingPool || new Pool(config.db);
pool.on?.("error", error => console.error("Database pool error:", error.message));

/* =========================
ROOT
========================= */

// MADINENI LYRICS START
require("./madineni-lyrics.cjs").mount(app, pool, { ...lyricsOptions, musicDir: MUSIC_DIR });
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

const result =
  await pool.query("SELECT NOW() AS time");

res.json({
  success: true,
  status: "ok",
  database: "connected",
  time: result.rows[0].time
});

} catch (error) {

console.error(
  "Health check error:",
  error.message
);

res.status(503).json({
  success: false,
  status: "error",
  database: "disconnected",
  error: error.message
});

}

});

/* =========================
DB TEST
========================= */

app.get("/api/db-test", async (req, res) => {

try {

const result =
  await pool.query(
    "SELECT NOW() AS current_time"
  );

res.json({
  connected: true,
  database: process.env.DB_NAME,
  time: result.rows[0].current_time
});

} catch (error) {

console.error(
  "Database connection error:",
  error.message
);

res.status(500).json({
  connected: false,
  error: error.message
});

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

if ([search, artist, album].some(value => value.length > 200)) {
  return res.status(400).json({ error: "Search filters must be 200 characters or fewer" });
}

let limit =
  Number.parseInt(
    req.query.limit,
    10
  );

let offset =
  Number.parseInt(
    req.query.offset,
    10
  );

if (
  !Number.isSafeInteger(limit) ||
  limit <= 0
) {
  limit = config.songsDefaultLimit;
}

if (limit > config.songsMaxLimit) {
  limit = config.songsMaxLimit;
}

if (
  !Number.isSafeInteger(offset) ||
  offset < 0
) {
  offset = 0;
}

const conditions = [];
const values = [];

let parameter = 1;


if (search !== "") {

  conditions.push(
    "(" +
    "songs.title ILIKE $" +
    parameter +
    " OR artists.name ILIKE $" +
    parameter +
    " OR albums.title ILIKE $" +
    parameter +
    ")"
  );

  values.push(
    "%" + search + "%"
  );

  parameter++;

}


if (artist !== "") {

  conditions.push(
    "artists.name ILIKE $" +
    parameter
  );

  values.push(
    "%" + artist + "%"
  );

  parameter++;

}


if (album !== "") {

  conditions.push(
    "albums.title ILIKE $" +
    parameter
  );

  values.push(
    "%" + album + "%"
  );

  parameter++;

}


const whereClause =
  conditions.length > 0
    ? "WHERE " +
      conditions.join(" AND ")
    : "";


// Fetch one extra row to advertise a next page without changing the JSON array.
values.push(limit + 1);
const limitParameter = parameter;
parameter++;

values.push(offset);
const offsetParameter = parameter;


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
      songs.created_at,
      COALESCE(NULLIF(albums.cover_path, ''), '/covers/' || songs.id || '.jpg') AS cover_art

    FROM songs

    LEFT JOIN artists
      ON songs.artist_id = artists.id

    LEFT JOIN albums
      ON songs.album_id = albums.id

    ${whereClause}

    ORDER BY songs.id ASC

    LIMIT $${limitParameter}
    OFFSET $${offsetParameter}
    `,
    values
  );

res.set("X-Songs-Page-Limit", String(limit));
if (result.rows.length > limit) {
  res.set("X-Songs-Next-Offset", String(offset + limit));
}
res.json(result.rows.slice(0, limit));

} catch (error) {

console.error(
  "Songs API error:",
  error.message
);

res.status(500).json({
  error: "Unable to load songs",
  details: error.message
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
  error: error.message
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
      songs.created_at,
      COALESCE(NULLIF(albums.cover_path, ''), '/covers/' || songs.id || '.jpg') AS cover_art

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
  error: error.message
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
  error: error.message
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
  error: error.message
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
  error: error.message
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
  details: error.message
});

}

});

/* =========================
CREATE PLAYLIST
========================= */

app.post("/api/playlists", async (req, res) => {

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

if (name.length > 120 || description.length > 2000) {
  return res.status(400).json({
    success: false,
    error: "Playlist name must be 120 characters or fewer and description 2000 characters or fewer"
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
  details: error.message
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
    details: error.message
  });

}

}
);

/* =========================
ADD SONG TO PLAYLIST
========================= */

app.post(
"/api/playlists/:id/songs",
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

  console.error(
    "Add playlist song error:",
    error.message
  );

  res.status(500).json({
    success: false,
    error:
      "Unable to add song to playlist",
    details: error.message
  });

}

}
);

/* =========================
REMOVE SONG FROM PLAYLIST
========================= */

app.delete(
"/api/playlists/:id/songs/:songId",
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
    details: error.message
  });

}

}
);

/* =========================
DELETE PLAYLIST
========================= */

app.delete(
"/api/playlists/:id",
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

  await pool.query(
    `
    DELETE FROM playlist_songs
    WHERE playlist_id = $1
    `,
    [playlistId]
  );

  const result =
    await pool.query(
      `
      DELETE FROM playlists
      WHERE id = $1

      RETURNING
        id,
        name
      `,
      [playlistId]
    );

  if (!result.rows.length) {

    return res.status(404).json({
      success: false,
      error: "Playlist not found"
    });

  }

  res.json({
    success: true,
    data: result.rows[0]
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
    details: error.message
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

app.use((error, req, res, next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({ success: false, error: "Request body is too large" });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ success: false, error: "Invalid JSON request body" });
  }
  console.error("Request failed:", error.message);
  res.status(500).json({ success: false, error: "Request could not be completed" });
});

return { app, pool, config };
}

/* =========================
SERVER
========================= */

if (require.main === module) {
const { app, config } = createApp();
app.listen(
config.port,
config.host,
() => {

console.log("");
console.log("======================================");
console.log("       MUSIC APP API SERVER");
console.log("======================================");
console.log("Port:      " + config.port);
console.log(
  "Local:     http://127.0.0.1:" + config.port
);
if (config.publicUrl) console.log("Public:    " + config.publicUrl);
console.log("======================================");
console.log("");

}
);
}

module.exports = { createApp };
