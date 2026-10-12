-- Optional performance migration. Run separately with psql, outside a transaction.
-- This creates indexes; it does not rewrite or remove songs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_title_trgm_idx
    ON songs USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS artists_name_trgm_idx
    ON artists USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS albums_title_trgm_idx
    ON albums USING gin (title gin_trgm_ops);
