const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const {
  escapeLike,
  requireWriteAuth,
  jsonErrorHandler
} = require("./http-utils");

// Defaults match the existing Ubuntu deployment; override via environment.
require("dotenv").config({
  path: process.env.ENV_FILE || "/opt/musicapp/app/config/.env"
});

const app = express();
app.disable("x-powered-by");

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const FRONTEND_DIR = process.env.FRONTEND_DIR || "/opt/musicapp/app/frontend";
const MUSIC_DIR = process.env.MUSIC_DIR || "/opt/musicapp/music/Songs";
const COVERS_DIR = process.env.COVERS_DIR || "/opt/musicapp/covers";

// Error text is only returned to clients when explicitly enabled (development).
const EXPOSE_ERROR_DETAILS = process.env.EXPOSE_ERROR_DETAILS === "true";

// Optional shared secret protecting write endpoints (see .env.example).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const writeGuard = requireWriteAuth(ADMIN_TOKEN);

// CORS: comma-separated allow-list; unset keeps the existing open behaviour.
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: "512kb" }));

app.use(express.static(FRONTEND_DIR));
app.use("/music", express.static(MUSIC_DIR));
app.use("/covers", express.static(COVERS_DIR));

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

/* =========================
ROOT
========================= */

// MADINENI LYRICS START
require("./madineni-lyrics.cjs").mount(app, pool, {musicDir:MUSIC_DIR, writeGuard});
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
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
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
  error: EXPOSE_ERROR_DETAILS ? error.message : "Internal server error"
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
  !Number.isInteger(limit) ||
  limit <= 0
) {
  limit = 1000000;
}

if (limit > 1000000) {
  limit = 1000000;
}

if (
  !Number.isInteger(offset) ||
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
    "%" + escapeLike(search) + "%"
  );

  parameter++;

}


if (artist !== "") {

  conditions.push(
    "artists.name ILIKE $" +
    parameter
  );

  values.push(
    "%" + escapeLike(artist) + "%"
  );

  parameter++;

}


if (album !== "") {

  conditions.push(
    "albums.title ILIKE $" +
    parameter
  );

  values.push(
    "%" + escapeLike(album) + "%"
  );

  parameter++;

}


const whereClause =
  conditions.length > 0
    ? "WHERE " +
      conditions.join(" AND ")
    : "";


values.push(limit);
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

  // Both deletes run in one transaction so a failure cannot leave a
  // playlist with its songs removed but the playlist itself still present.
  const client = await pool.connect();
  let result;

  try {

    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM playlist_songs
      WHERE playlist_id = $1
      `,
      [playlistId]
    );

    result = await client.query(
      `
      DELETE FROM playlists
      WHERE id = $1

      RETURNING
        id,
        name
      `,
      [playlistId]
    );

    await client.query("COMMIT");

  } catch (transactionError) {

    await client.query("ROLLBACK").catch(() => {});
    throw transactionError;

  } finally {

    client.release();

  }

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

/* =========================
SERVER
========================= */

app.listen(
PORT,
"0.0.0.0",
() => {

console.log("");
console.log("======================================");
console.log("       MUSIC APP API SERVER");
console.log("======================================");
console.log("Port:      " + PORT);
console.log(
  "Local:     http://127.0.0.1:" + PORT
);
console.log(
  "Wi-Fi:     http://192.168.4.204:" + PORT
);
console.log(
  "Tailscale: http://100.83.79.17:" + PORT
);
console.log("======================================");
console.log("");

}
);
