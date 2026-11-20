-- AI lyric drafts. Separate from madineni_song_lyrics: nothing here changes songs, albums,
-- artists, audio, artwork or the existing lyrics table. Apply with:
--   python3 audio_pipeline/scripts/ai_lyrics.py init-schema --apply
CREATE TABLE IF NOT EXISTS madineni_ai_lyrics (
  id BIGSERIAL PRIMARY KEY,
  song_id BIGINT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','rejected','instrumental')),
  language TEXT,
  plain_text TEXT,
  synced_lrc TEXT,
  confidence REAL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  reviewed_text TEXT,
  reviewed_lrc TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (song_id, model_version)
);
CREATE INDEX IF NOT EXISTS madineni_ai_lyrics_status_idx ON madineni_ai_lyrics(status);
-- What the reviewer changed, kept so later runs can learn from real corrections.
CREATE TABLE IF NOT EXISTS madineni_ai_lyrics_feedback (
  id BIGSERIAL PRIMARY KEY,
  draft_id BIGINT NOT NULL REFERENCES madineni_ai_lyrics(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  edited_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
