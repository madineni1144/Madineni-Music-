# AI lyric drafts

For songs where the lyrics lookup returned `not_found`, `audio_pipeline/scripts/ai_lyrics.py` transcribes the
singing with Whisper and stores a time-synced **draft**. Nothing is shown to listeners until a person approves it.

## Safety
- Reads `songs` and `madineni_song_lyrics` only. Writes only to `madineni_ai_lyrics` and `madineni_ai_lyrics_feedback`
  (`database/migrations/001_ai_lyrics.sql`). Songs, albums, artists, audio, artwork and existing lyrics are never changed.
- Every command that writes needs `--apply`; without it the command is a dry run. `run` caps at 50 songs per run.
- Audio paths must resolve inside the music folder. No network or paid API is used (Whisper runs locally).
- Songs with too little singing are stored as `instrumental`, with no invented text.

## Setup on the server (not done by this change)
1. `pip install openai-whisper` and install `ffmpeg`. Use a large Whisper model for Telugu/Hindi/Tamil.
2. `python3 audio_pipeline/scripts/ai_lyrics.py init-schema --apply`

## Use
1. `... list` shows songs waiting for lyrics.
2. `... run --limit 5` transcribes and prints results (stores nothing). Add `--apply` to store drafts.
3. Review drafts in `madineni_ai_lyrics`, then `... approve --id N --apply` (optionally `--edited-file fixed.lrc`)
   or `... reject --id N --apply`. Edits are kept in `madineni_ai_lyrics_feedback` for future improvement.

## Not included yet
Publishing approved drafts into the app's lyrics display (a backend route behind the existing write token).
