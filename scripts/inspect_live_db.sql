-- READ-ONLY catalogue inspection for the music database. It reads only PostgreSQL system catalogues
-- (pg_catalog / information_schema) and the privileges of the role that runs it. It never reads a row of
-- application data (no SELECT from songs, artists, albums, playlists, playlist_songs or lyrics, no counts),
-- changes nothing, and prints no credentials.
--
-- Run it as the SAME role the application connects with, so the privilege answers are the app's:
--   PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' \
--     psql -X -v ON_ERROR_STOP=1 -h <host> -U <app role> -d <database> -W -f inspect_live_db.sql
-- (-W prompts for the password; never put it on the command line.)
-- Running as a superuser instead reports the superuser's privileges, not the application's.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

\echo '### session'
SELECT current_database() AS database, current_user AS role, current_schema() AS schema,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only_transaction;

\echo '### role attributes of the connecting role'
SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname = current_user;

\echo '### tables the API code uses: present?'
SELECT t.name AS table_name, to_regclass(t.name) IS NOT NULL AS exists
FROM (VALUES ('songs'), ('artists'), ('albums'), ('playlists'), ('playlist_songs'), ('madineni_song_lyrics')) AS t(name)
ORDER BY 1;

\echo '### table privileges of the connecting role (CREATE on the schema is needed by startup CREATE TABLE IF NOT EXISTS)'
SELECT t.name AS table_name,
       CASE WHEN r IS NULL THEN NULL ELSE has_table_privilege(current_user, r, 'SELECT') END AS can_select,
       CASE WHEN r IS NULL THEN NULL ELSE has_table_privilege(current_user, r, 'INSERT') END AS can_insert,
       CASE WHEN r IS NULL THEN NULL ELSE has_table_privilege(current_user, r, 'UPDATE') END AS can_update,
       CASE WHEN r IS NULL THEN NULL ELSE has_table_privilege(current_user, r, 'DELETE') END AS can_delete
FROM (VALUES ('songs'), ('artists'), ('albums'), ('playlists'), ('playlist_songs'), ('madineni_song_lyrics')) AS t(name),
     LATERAL (SELECT to_regclass(t.name) AS r) x
ORDER BY 1;
SELECT has_schema_privilege(current_user, current_schema(), 'USAGE')  AS schema_usage,
       has_schema_privilege(current_user, current_schema(), 'CREATE') AS schema_create;

\echo '### sequences owned by the write tables: can the role use them (needed by INSERT)?'
SELECT c.relname AS sequence_name, has_sequence_privilege(current_user, c.oid, 'USAGE') AS can_use
FROM pg_class c
JOIN pg_depend d ON d.objid = c.oid AND d.deptype IN ('a', 'i')
WHERE c.relkind = 'S'
  AND d.refobjid = ANY (ARRAY[to_regclass('playlists'), to_regclass('playlist_songs'), to_regclass('madineni_song_lyrics')]::oid[])
ORDER BY 1;

\echo '### columns (names, types, nullability; default expressions are not printed)'
SELECT table_name, column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('songs', 'artists', 'albums', 'playlists', 'playlist_songs', 'madineni_song_lyrics')
ORDER BY table_name, ordinal_position;

\echo '### constraints: playlist_songs needs UNIQUE/PRIMARY KEY (playlist_id, song_id) and FKs to playlists and songs'
SELECT conrelid::regclass AS table_name, conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = ANY (ARRAY[to_regclass('songs'), to_regclass('artists'), to_regclass('albums'), to_regclass('playlists'),
                            to_regclass('playlist_songs'), to_regclass('madineni_song_lyrics')]::oid[])
ORDER BY 1, 3, 2;

\echo '### indexes'
SELECT tablename AS table_name, indexname AS name, indexdef AS definition
FROM pg_indexes
WHERE schemaname = current_schema()
  AND tablename IN ('songs', 'artists', 'albums', 'playlists', 'playlist_songs', 'madineni_song_lyrics')
ORDER BY 1, 2;

\echo '### row-level security and user triggers on these tables (either can change what a write does)'
SELECT c.relname AS table_name, c.relrowsecurity AS row_level_security,
       (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) AS user_triggers
FROM pg_class c
WHERE c.oid = ANY (ARRAY[to_regclass('songs'), to_regclass('artists'), to_regclass('albums'), to_regclass('playlists'),
                         to_regclass('playlist_songs'), to_regclass('madineni_song_lyrics')]::oid[])
ORDER BY 1;

\echo '### transport of THIS session (pg_stat_ssl for the session running this inspection)'
SELECT current_setting('ssl') AS server_ssl_setting,
       COALESCE(s.ssl, false) AS this_session_uses_tls, s.version AS tls_version, s.cipher AS tls_cipher,
       inet_server_addr() IS NULL AS unix_socket
FROM (SELECT 1) x LEFT JOIN pg_stat_ssl s ON s.pid = pg_backend_pid();

ROLLBACK;
\echo '### end of catalogue inspection'
