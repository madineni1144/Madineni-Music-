from pathlib import Path
import argparse
import hashlib

from audio_pipeline.scripts.album_policy import (
    AMBIGUOUS,
    REUSE,
    choose_album,
)
from audio_pipeline.scripts.db import (
    get_connection,
    get_import_job,
    record_item_error,
)
from audio_pipeline.scripts.errors import (
    AmbiguousAlbumError,
    ErrorCategory,
    ManualReviewError,
    classify_exception,
)

MUSIC_ROOT = Path("/opt/musicapp/music/Songs").resolve()


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", type=int, required=True)
    return parser.parse_args()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_items(job_id):
    connection = get_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, title, artist, album,
                       local_file_path, sha256, song_id
                FROM import_items
                WHERE job_id = %s
                  AND status IN ('validated', 'warning')
                ORDER BY id
                """,
                (job_id,),
            )
            return cursor.fetchall()
    finally:
        connection.close()


def validate_item(item):
    item_id, title, artist, album, file_path, expected_hash, song_id = item

    if not all([title, artist, album, file_path, expected_hash]):
        raise ValueError("Missing required registration metadata")

    path = Path(file_path).resolve()

    if not path.is_relative_to(MUSIC_ROOT):
        raise ValueError(f"Audio is outside music library: {path}")

    if not path.is_file():
        raise FileNotFoundError(f"Audio file missing: {path}")

    if path.suffix.lower() != ".mp3":
        raise ValueError(f"Unsupported audio format: {path.suffix}")

    if sha256_file(path) != expected_hash.lower():
        raise ManualReviewError(f"SHA-256 mismatch: {path}")

    return path


def get_or_create_artist(cursor, name):
    cursor.execute(
        """
        SELECT id FROM artists
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))
        ORDER BY id LIMIT 1
        """,
        (name,),
    )
    row = cursor.fetchone()
    if row:
        return row[0]

    cursor.execute(
        "INSERT INTO artists (name) VALUES (%s) RETURNING id",
        (name,),
    )
    return cursor.fetchone()[0]


def get_or_create_album(cursor, title, artist_id):
    """Reuse an album only when title AND artist match.

    Existing albums are never modified. Same-title albums that belong
    to another artist are left alone and a new album is created.
    Same-title albums with no recorded artist are ambiguous and are
    sent to manual review instead of being merged.
    """
    cursor.execute(
        """
        SELECT id, title, artist_id FROM albums
        WHERE LOWER(TRIM(title)) = LOWER(TRIM(%s))
        ORDER BY id
        """,
        (title,),
    )
    candidates = cursor.fetchall()

    decision, album_id = choose_album(candidates, title, artist_id)

    if decision == REUSE:
        return album_id

    if decision == AMBIGUOUS:
        raise AmbiguousAlbumError(
            f"Album '{title}' is ambiguous for this artist "
            "(existing album with no artist or duplicates). "
            "Manual review required; nothing was merged."
        )

    cursor.execute(
        """
        INSERT INTO albums (title, artist_id, year, cover_path)
        VALUES (%s, %s, NULL, NULL)
        RETURNING id
        """,
        (title, artist_id),
    )
    return cursor.fetchone()[0]


def register_one(item):
    item_id, title, artist, album, _, _, linked_song_id = item
    path = validate_item(item)

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT song_id, status
                FROM import_items
                WHERE id = %s
                FOR UPDATE
                """,
                (item_id,),
            )
            current = cursor.fetchone()

            if not current or current[1] not in ("validated", "warning"):
                raise ManualReviewError("Import item is no longer eligible")

            if current[0] is not None:
                cursor.execute(
                    "SELECT file_path FROM songs WHERE id = %s",
                    (current[0],),
                )
                existing = cursor.fetchone()

                if not existing or Path(existing[0]).resolve() != path:
                    raise ManualReviewError("Linked song path mismatch")

                connection.commit()
                return current[0], "already linked"

            cursor.execute(
                "SELECT id FROM songs WHERE file_path = %s LIMIT 1",
                (str(path),),
            )
            existing = cursor.fetchone()

            if existing:
                song_id = existing[0]
                action = "reused"
            else:
                artist_id = get_or_create_artist(cursor, artist)
                album_id = get_or_create_album(cursor, album, artist_id)

                cursor.execute(
                    """
                    INSERT INTO songs (
                        title, artist_id, album_id,
                        file_path, file_format, file_size
                    )
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        title, artist_id, album_id,
                        str(path), "mp3", path.stat().st_size,
                    ),
                )
                song_id = cursor.fetchone()[0]
                action = "created"

            cursor.execute(
                """
                UPDATE import_items
                SET song_id = %s, updated_at = NOW()
                WHERE id = %s
                  AND song_id IS NULL
                  AND status IN ('validated', 'warning')
                """,
                (song_id, item_id),
            )

            if cursor.rowcount != 1:
                raise ManualReviewError("Could not link import item")

        connection.commit()
        return song_id, action

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def main():
    args = parse_arguments()

    if get_import_job(args.job_id) is None:
        raise RuntimeError(f"Import job {args.job_id} not found")

    items = get_items(args.job_id)

    created = 0
    reused = 0
    failed = 0
    unrecorded = 0

    print(f"Registration job: {args.job_id}", flush=True)
    print(f"Eligible items: {len(items)}", flush=True)

    for item in items:
        item_id = item[0]

        try:
            song_id, action = register_one(item)
            print(
                f"[{item_id}] {action}: song_id={song_id}",
                flush=True,
            )

            if action == "created":
                created += 1
            else:
                reused += 1

        except Exception as error:
            category = classify_exception(error)

            if category == ErrorCategory.SYSTEM_ERROR:
                raise

            failed += 1
            reason = f"Registration {category.value}: {error}"

            print(f"[{item_id}] {reason}", flush=True)

            try:
                record_item_error(item_id, category.value, reason)
            except Exception as db_error:
                unrecorded += 1
                print(
                    f"[{item_id}] ERROR STATUS UPDATE ERROR: "
                    f"{db_error}",
                    flush=True,
                )

    print(
        f"Registration complete: created={created}, "
        f"reused={reused}, failed={failed}, "
        f"unrecorded={unrecorded}",
        flush=True,
    )

    if unrecorded:
        raise RuntimeError(
            f"{unrecorded} registration failures were not recorded"
        )


if __name__ == "__main__":
    main()
