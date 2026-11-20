"""AI lyric drafts for songs the lyrics lookup could not find.

Reads songs whose madineni_song_lyrics.status is 'not_found', transcribes the singing with Whisper,
and stores a time-synced DRAFT in madineni_ai_lyrics. Nothing goes live: a person approves or
rejects each draft. Existing songs, audio, artwork and madineni_song_lyrics are never modified.

    python3 audio_pipeline/scripts/ai_lyrics.py list                   # dry run, read-only
    python3 audio_pipeline/scripts/ai_lyrics.py run --limit 5          # transcribes, prints, writes nothing
    python3 audio_pipeline/scripts/ai_lyrics.py run --limit 5 --apply  # also stores drafts
    python3 audio_pipeline/scripts/ai_lyrics.py approve --id 3 [--edited-file fixed.lrc] --apply
    python3 audio_pipeline/scripts/ai_lyrics.py reject --id 3 --apply
    python3 audio_pipeline/scripts/ai_lyrics.py init-schema --apply

Whisper (openai-whisper) and ffmpeg are needed only for `run`; they are imported lazily.
"""
import argparse
import math
import os
import re
import sys
from pathlib import Path

MODEL_VERSION = "ai-lyrics-1"
MAX_LIMIT = 50
MIN_WORDS_FOR_VOCALS = 8
MIN_SEGMENT_CONFIDENCE = 0.25
MAX_NO_SPEECH_PROB = 0.6
MAX_REPEATS = 3
DEFAULT_MUSIC_ROOT = "/opt/musicapp/music/Songs"
SCHEMA_FILE = Path(__file__).resolve().parents[2] / "database" / "migrations" / "001_ai_lyrics.sql"

CANDIDATES_SQL = """
SELECT s.id, s.title, s.file_path
FROM songs s
JOIN madineni_song_lyrics l ON l.song_id = s.id
LEFT JOIN madineni_ai_lyrics a ON a.song_id = s.id AND a.model_version = %s
WHERE l.status = 'not_found' AND a.id IS NULL
ORDER BY s.id
LIMIT %s
"""


def format_timestamp(seconds):
    seconds = max(0.0, float(seconds))
    centis = int(round(seconds * 100))
    return f"{centis // 6000:02}:{(centis % 6000) / 100:05.2f}"


def to_lrc(segments):
    return "\n".join(f"[{format_timestamp(s['start'])}]{s['text']}" for s in segments)


def to_plain(segments):
    return "\n".join(s["text"] for s in segments)


def confidence_from_logprob(avg_logprob):
    try:
        value = math.exp(float(avg_logprob))
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return min(1.0, max(0.0, value))


def clean_segments(raw_segments):
    """Drop empty, silent, low-confidence and looping (hallucinated) segments."""
    cleaned, last, repeats = [], None, 0
    for raw in raw_segments or []:
        text = re.sub(r"\s+", " ", str(raw.get("text", ""))).strip()
        if not text:
            continue
        if float(raw.get("no_speech_prob", 0) or 0) > MAX_NO_SPEECH_PROB:
            continue
        confidence = confidence_from_logprob(raw.get("avg_logprob", -1.0))
        if confidence < MIN_SEGMENT_CONFIDENCE:
            continue
        key = text.casefold()
        repeats = repeats + 1 if key == last else 1
        last = key
        if repeats > MAX_REPEATS:
            continue
        cleaned.append({"start": float(raw.get("start", 0)), "end": float(raw.get("end", 0)),
                        "text": text, "confidence": confidence})
    return cleaned


def overall_confidence(segments):
    if not segments:
        return 0.0
    return round(sum(s["confidence"] for s in segments) / len(segments), 3)


def classify(segments):
    """'instrumental' when there is too little singing to be lyrics, otherwise 'draft'."""
    words = sum(len(s["text"].split()) for s in segments)
    return "draft" if words >= MIN_WORDS_FOR_VOCALS else "instrumental"


def resolve_audio_path(file_path, music_root=DEFAULT_MUSIC_ROOT):
    """Same rules as the backend: '/music/' prefix is relative to the root and the file must stay inside it."""
    if not file_path:
        return None
    name = str(file_path)
    if name.startswith("/music/"):
        name = name[7:]
    try:
        root = Path(music_root).resolve(strict=True)
        candidate = Path(name)
        candidate = (candidate if candidate.is_absolute() else root / candidate).resolve(strict=True)
        candidate.relative_to(root)
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_file() else None


def build_draft(whisper_result):
    segments = clean_segments(whisper_result.get("segments"))
    status = classify(segments)
    draft = {"status": status, "language": whisper_result.get("language"), "segments": segments,
             "confidence": overall_confidence(segments)}
    if status == "draft":
        draft["plain_text"], draft["synced_lrc"] = to_plain(segments), to_lrc(segments)
    else:
        draft["plain_text"] = draft["synced_lrc"] = None
    return draft


def transcribe(audio_path, model_name="large-v3", language=None):
    try:
        import whisper
    except ImportError:
        raise SystemExit("openai-whisper and ffmpeg are required for `run` (see docs/AI-LYRICS.md).")
    model = whisper.load_model(model_name)
    return model.transcribe(str(audio_path), language=language, condition_on_previous_text=False)


def _connect():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from db import get_connection
    return get_connection()


def fetch_candidates(connection, limit):
    with connection.cursor() as cursor:
        cursor.execute(CANDIDATES_SQL, (MODEL_VERSION, limit))
        return cursor.fetchall()


def store_draft(connection, song_id, draft, model_name):
    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO madineni_ai_lyrics
               (song_id, status, language, plain_text, synced_lrc, confidence, model, model_version)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (song_id, model_version) DO NOTHING""",
            (song_id, draft["status"], draft["language"], draft["plain_text"], draft["synced_lrc"],
             draft["confidence"], f"whisper-{model_name}", MODEL_VERSION))
    connection.commit()


def review(connection, draft_id, new_status, edited_text=None):
    with connection.cursor() as cursor:
        cursor.execute("SELECT plain_text, synced_lrc FROM madineni_ai_lyrics WHERE id=%s AND status='draft'",
                       (draft_id,))
        row = cursor.fetchone()
        if row is None:
            raise SystemExit(f"Draft {draft_id} not found or already reviewed.")
        reviewed_lrc = edited_text if edited_text is not None else row[1]
        reviewed_plain = re.sub(r"^\[[^\]]*\]", "", reviewed_lrc or "", flags=re.M)
        cursor.execute("""UPDATE madineni_ai_lyrics SET status=%s, reviewed_text=%s, reviewed_lrc=%s,
                          reviewed_at=NOW() WHERE id=%s AND status='draft'""",
                       (new_status, reviewed_plain if new_status == "approved" else None,
                        reviewed_lrc if new_status == "approved" else None, draft_id))
        if new_status == "approved" and edited_text is not None and reviewed_plain != row[0]:
            cursor.execute("INSERT INTO madineni_ai_lyrics_feedback (draft_id, original_text, edited_text) "
                           "VALUES (%s,%s,%s)", (draft_id, row[0] or "", reviewed_plain))
    connection.commit()


def cmd_run(args):
    limit = min(max(args.limit, 1), MAX_LIMIT)
    connection = _connect()
    try:
        rows = fetch_candidates(connection, limit)
        print(f"{len(rows)} song(s) without lyrics" + ("" if args.apply else " (dry run: nothing is stored)"))
        for song_id, title, file_path in rows:
            audio = resolve_audio_path(file_path, args.music_root)
            if audio is None:
                print(f"{song_id}: {title} -> skipped (audio file not found under the music folder)")
                continue
            draft = build_draft(transcribe(audio, args.model, args.language))
            print(f"{song_id}: {title} -> {draft['status']} (confidence {draft['confidence']}, "
                  f"{len(draft['segments'])} lines)")
            if args.apply:
                store_draft(connection, song_id, draft, args.model)
    finally:
        connection.close()


def cmd_list(args):
    connection = _connect()
    try:
        for song_id, title, _ in fetch_candidates(connection, min(max(args.limit, 1), MAX_LIMIT)):
            print(f"{song_id}: {title}")
    finally:
        connection.close()


def cmd_review(args, status):
    if not args.apply:
        print(f"Dry run: would mark draft {args.id} as {status}. Add --apply to do it.")
        return
    edited = Path(args.edited_file).read_text(encoding="utf-8") if getattr(args, "edited_file", None) else None
    connection = _connect()
    try:
        review(connection, args.id, status, edited)
        print(f"Draft {args.id} marked {status}.")
    finally:
        connection.close()


def cmd_init_schema(args):
    if not args.apply:
        print("Dry run: would create madineni_ai_lyrics and madineni_ai_lyrics_feedback. Add --apply.")
        return
    connection = _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(SCHEMA_FILE.read_text(encoding="utf-8"))
        connection.commit()
        print("Schema ready.")
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "run"):
        p = sub.add_parser(name)
        p.add_argument("--limit", type=int, default=5)
        if name == "run":
            p.add_argument("--apply", action="store_true")
            p.add_argument("--model", default=os.getenv("MUSICAPP_WHISPER_MODEL", "large-v3"))
            p.add_argument("--language", default=None)
            p.add_argument("--music-root", default=os.getenv("MUSICAPP_MUSIC_ROOT", DEFAULT_MUSIC_ROOT))
    for name in ("approve", "reject"):
        p = sub.add_parser(name)
        p.add_argument("--id", type=int, required=True)
        p.add_argument("--apply", action="store_true")
        if name == "approve":
            p.add_argument("--edited-file")
    sub.add_parser("init-schema").add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    {"list": cmd_list, "run": cmd_run, "init-schema": cmd_init_schema,
     "approve": lambda a: cmd_review(a, "approved"), "reject": lambda a: cmd_review(a, "rejected")}[args.command](args)


if __name__ == "__main__":
    main()
