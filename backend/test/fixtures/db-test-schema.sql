-- SYNTHETIC test schema for the disposable-database integration tests.
--
-- The repository contains no migration for the core tables, so this is INFERRED
-- from the SQL the API runs (server.js, songs-query.js, madineni-lyrics.cjs). It is
-- NOT a copy of production. Constraints the write routes rely on are stated
-- explicitly so a mismatch with production is visible:
--   * playlist_songs PRIMARY KEY (playlist_id, song_id)  -> ON CONFLICT DO NOTHING dedupes
--   * playlist_songs FOREIGN KEYs to playlists and songs  -> error 23503 becomes HTTP 404
--   * no ON DELETE CASCADE on playlist_songs.playlist_id  -> deletePlaylist() removes links itself
-- docs/DEPLOYMENT.md has a read-only query to compare these with the real database.
-- madineni_song_lyrics is NOT defined here: the test runs the real DDL from madineni-lyrics.cjs.
CREATE TABLE artists (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE albums  (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, cover_path TEXT);
CREATE TABLE songs (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id BIGINT REFERENCES artists(id),
  album_id  BIGINT REFERENCES albums(id),
  track_number INTEGER,
  duration_seconds INTEGER,
  file_path TEXT NOT NULL,
  file_format TEXT,
  file_size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE playlists (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE playlist_songs (
  playlist_id BIGINT NOT NULL REFERENCES playlists(id),
  song_id     BIGINT NOT NULL REFERENCES songs(id),
  PRIMARY KEY (playlist_id, song_id)
);
