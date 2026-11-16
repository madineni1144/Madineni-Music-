"use strict";

const { escapeLike } = require("./http-utils");

/**
 * Build the paged song-list query.
 *
 * Paging is deterministic because the ONLY sort key is songs.id, which is
 * unique (it is the target of REFERENCES songs(id) in the lyrics schema). Any
 * new sort option must keep songs.id as the final tie-breaker, otherwise
 * LIMIT/OFFSET pages can repeat or skip rows.
 */
function buildSongsQuery({ search = "", artist = "", album = "", limit, offset }) {
  const conditions = [];
  const values = [];

  if (search !== "") {
    values.push("%" + escapeLike(search) + "%");
    const p = values.length;
    conditions.push(
      `(songs.title ILIKE $${p} OR artists.name ILIKE $${p} OR albums.title ILIKE $${p})`
    );
  }

  if (artist !== "") {
    values.push("%" + escapeLike(artist) + "%");
    conditions.push(`artists.name ILIKE $${values.length}`);
  }

  if (album !== "") {
    values.push("%" + escapeLike(album) + "%");
    conditions.push(`albums.title ILIKE $${values.length}`);
  }

  values.push(limit);
  const limitParameter = values.length;
  values.push(offset);
  const offsetParameter = values.length;

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const text = `
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

    ${where}

    ORDER BY songs.id ASC

    LIMIT $${limitParameter}
    OFFSET $${offsetParameter}
  `;

  return { text, values };
}

module.exports = { buildSongsQuery };
