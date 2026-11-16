import json
import os
from datetime import datetime, timezone

import psycopg2
from dotenv import load_dotenv

from audio_pipeline.scripts.errors import ErrorCategory
from audio_pipeline.scripts.item_state import plan_error_update
from audio_pipeline.scripts.retry_policy import DEFAULT_POLICY


ENV_FILE = "/etc/musicapp.env"


def get_connection():
    load_dotenv(ENV_FILE)

    required = [
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    ]

    missing = [
        name
        for name in required
        if not os.getenv(name)
    ]

    if missing:
        raise RuntimeError(
            "Missing database environment variables: "
            + ", ".join(missing)
        )

    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def test_connection():
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT current_database();"
            )

            database = cursor.fetchone()[0]

        print(
            f"PostgreSQL connection: OK ({database})"
        )

    finally:
        connection.close()


def create_import_job(run_id):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO import_jobs (
                    run_id,
                    status
                )
                VALUES (%s, %s)
                RETURNING id;
                """,
                (
                    run_id,
                    "running",
                ),
            )

            job_id = cursor.fetchone()[0]

        connection.commit()

        return job_id

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def get_import_job(job_id):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    run_id,
                    status,
                    total_files,
                    successful_files,
                    failed_files,
                    duplicate_files,
                    started_at,
                    completed_at
                FROM import_jobs
                WHERE id = %s;
                """,
                (job_id,),
            )

            row = cursor.fetchone()

        if row is None:
            return None

        return {
            "id": row[0],
            "run_id": row[1],
            "status": row[2],
            "total_files": row[3],
            "successful_files": row[4],
            "failed_files": row[5],
            "duplicate_files": row[6],
            "started_at": row[7],
            "completed_at": row[8],
        }

    finally:
        connection.close()


def get_latest_import_job():
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    run_id,
                    status,
                    total_files,
                    successful_files,
                    failed_files,
                    duplicate_files,
                    started_at,
                    completed_at
                FROM import_jobs
                ORDER BY id DESC
                LIMIT 1;
                """
            )

            row = cursor.fetchone()

        if row is None:
            return None

        return {
            "id": row[0],
            "run_id": row[1],
            "status": row[2],
            "total_files": row[3],
            "successful_files": row[4],
            "failed_files": row[5],
            "duplicate_files": row[6],
            "started_at": row[7],
            "completed_at": row[8],
        }

    finally:
        connection.close()


def complete_import_job(
    job_id,
    total_files,
    successful_files=0,
    failed_files=0,
    duplicate_files=0,
):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_jobs
                SET
                    status = %s,
                    total_files = %s,
                    successful_files = %s,
                    failed_files = %s,
                    duplicate_files = %s,
                    completed_at = NOW()
                WHERE id = %s;
                """,
                (
                    "completed",
                    total_files,
                    successful_files,
                    failed_files,
                    duplicate_files,
                    job_id,
                ),
            )

            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Import job {job_id} was not updated."
                )

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def create_import_item(
    job_id,
    drive_file_id,
    original_filename,
    sha256=None,
    title=None,
    artist=None,
    album=None,
    local_file_path=None,
    status="pending",
):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO import_items (
                    job_id,
                    drive_file_id,
                    original_filename,
                    sha256,
                    title,
                    artist,
                    album,
                    local_file_path,
                    status
                )
                VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s
                )
                RETURNING id;
                """,
                (
                    job_id,
                    drive_file_id,
                    original_filename,
                    sha256,
                    title,
                    artist,
                    album,
                    local_file_path,
                    status,
                ),
            )

            item_id = cursor.fetchone()[0]

        connection.commit()

        return item_id

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def get_import_items(
    job_id=None,
    statuses=None,
):
    connection = get_connection()

    try:
        query = """
            SELECT
                id,
                job_id,
                drive_file_id,
                original_filename,
                sha256,
                title,
                artist,
                album,
                local_file_path,
                song_id,
                status,
                failure_reason,
                retry_count,
                playback_validated,
                created_at,
                updated_at
            FROM import_items
        """

        conditions = []
        parameters = []

        if job_id is not None:
            conditions.append(
                "job_id = %s"
            )
            parameters.append(job_id)

        if statuses:
            conditions.append(
                "status = ANY(%s)"
            )
            parameters.append(list(statuses))

        if conditions:
            query += (
                " WHERE "
                + " AND ".join(conditions)
            )

        query += " ORDER BY id;"

        with connection.cursor() as cursor:
            cursor.execute(
                query,
                tuple(parameters),
            )

            rows = cursor.fetchall()

        return [
            {
                "id": row[0],
                "job_id": row[1],
                "drive_file_id": row[2],
                "original_filename": row[3],
                "sha256": row[4],
                "title": row[5],
                "artist": row[6],
                "album": row[7],
                "local_file_path": row[8],
                "song_id": row[9],
                "status": row[10],
                "failure_reason": row[11],
                "retry_count": row[12],
                "playback_validated": row[13],
                "created_at": row[14],
                "updated_at": row[15],
            }
            for row in rows
        ]

    finally:
        connection.close()


def get_pending_import_items(job_id=None):
    return get_import_items(
        job_id=job_id,
        statuses=["pending"],
    )


def update_import_item_validation(
    item_id,
    status,
    title=None,
    artist=None,
    album=None,
    failure_reason=None,
    original_metadata=None,
    error_category=None,
):
    """Record a validation result.

    Metadata is preserved: a None title/artist/album never overwrites
    an existing value, and the first-seen original tags are kept in
    original_metadata.
    """
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_items
                SET
                    status = %s,
                    title = COALESCE(%s, title),
                    artist = COALESCE(%s, artist),
                    album = COALESCE(%s, album),
                    original_metadata = COALESCE(
                        original_metadata, %s::jsonb
                    ),
                    error_category = %s,
                    failure_reason = %s,
                    updated_at = NOW()
                WHERE id = %s;
                """,
                (
                    status,
                    title,
                    artist,
                    album,
                    json.dumps(original_metadata)
                    if original_metadata is not None
                    else None,
                    error_category,
                    failure_reason,
                    item_id,
                ),
            )

            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Import item {item_id} "
                    "was not updated."
                )

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def update_import_item_metadata(
    item_id,
    title,
    artist,
    album,
):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_items
                SET
                    title = %s,
                    artist = %s,
                    album = %s,
                    updated_at = NOW()
                WHERE id = %s;
                """,
                (
                    title,
                    artist,
                    album,
                    item_id,
                ),
            )

            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Import item {item_id} "
                    "was not updated."
                )

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def find_duplicate_by_sha256(sha256, job_id=None):
    """Find a VERIFIED earlier import of the same content.

    Counts as a duplicate only when the content was actually imported
    (song_id set) or is in flight in the same job. Previously failed,
    retrying or manual-review attempts are NOT duplicates, so a failed
    file can be imported again.
    """
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    job_id,
                    drive_file_id,
                    original_filename,
                    sha256,
                    status
                FROM import_items
                WHERE sha256 = %s
                  AND (
                        song_id IS NOT NULL
                     OR (
                            job_id = %s
                        AND status IN (
                            'pending', 'validated', 'warning'
                        )
                     )
                  )
                ORDER BY id
                LIMIT 1;
                """,
                (sha256, job_id),
            )

            row = cursor.fetchone()

        if row is None:
            return None

        return {
            "id": row[0],
            "job_id": row[1],
            "drive_file_id": row[2],
            "original_filename": row[3],
            "sha256": row[4],
            "status": row[5],
        }

    finally:
        connection.close()


def find_duplicate_by_drive_file_id(
    drive_file_id,
):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    job_id,
                    drive_file_id,
                    original_filename,
                    sha256,
                    status
                FROM import_items
                WHERE drive_file_id = %s
                ORDER BY id
                LIMIT 1;
                """,
                (drive_file_id,),
            )

            row = cursor.fetchone()

        if row is None:
            return None

        return {
            "id": row[0],
            "job_id": row[1],
            "drive_file_id": row[2],
            "original_filename": row[3],
            "sha256": row[4],
            "status": row[5],
        }

    finally:
        connection.close()


def get_or_create_import_job(run_id):
    """Create an import job or reuse an existing run ID."""
    if not run_id or not run_id.strip():
        raise ValueError("Import run ID cannot be empty.")

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO import_jobs (run_id, status)
                VALUES (%s, 'running')
                ON CONFLICT (run_id)
                DO UPDATE SET run_id = EXCLUDED.run_id
                RETURNING id;
                """,
                (run_id,),
            )

            job_id = cursor.fetchone()[0]

        connection.commit()
        return job_id

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def mark_import_item_failed(item_id, failure_reason):
    """Mark an item failed (INVALID_MEDIA only) keeping its metadata.

    Prefer record_item_error(), which enforces the error categories.
    """
    if not failure_reason or not str(failure_reason).strip():
        raise ValueError("Failure reason cannot be empty.")

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_items
                SET
                    status = 'failed',
                    error_category = 'INVALID_MEDIA',
                    failure_reason = %s,
                    updated_at = NOW()
                WHERE id = %s
                  AND status IN ('pending', 'validated', 'warning')
                  AND song_id IS NULL;
                """,
                (str(failure_reason), item_id),
            )

            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Import item {item_id} was not eligible "
                    "for failure status update."
                )

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def record_item_error(
    item_id,
    category,
    reason,
    policy=DEFAULT_POLICY,
    now=None,
):
    """Record an error using explicit categories, idempotently.

    Metadata (title, artist, album, ids, original_metadata) is never
    touched. SYSTEM_ERROR raises and changes nothing. Retry state
    (retry_count, next_retry_at) persists on the row, so repeating the
    call after a crash continues the same bounded schedule.
    Returns the applied update dict.
    """
    if not reason or not str(reason).strip():
        raise ValueError("Error reason cannot be empty.")

    now = now or datetime.now(timezone.utc)
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT status, song_id, retry_count
                FROM import_items
                WHERE id = %s
                FOR UPDATE;
                """,
                (item_id,),
            )
            row = cursor.fetchone()

            if row is None:
                raise RuntimeError(f"Import item {item_id} not found.")

            update = plan_error_update(
                status=row[0],
                song_id=row[1],
                retry_count=row[2],
                category=category,
                now=now,
                policy=policy,
            )

            cursor.execute(
                """
                UPDATE import_items
                SET
                    status = %s,
                    error_category = %s,
                    retry_count = %s,
                    next_retry_at = %s,
                    failure_reason = %s,
                    updated_at = NOW()
                WHERE id = %s;
                """,
                (
                    update["status"],
                    update["error_category"],
                    update["retry_count"],
                    update["next_retry_at"],
                    str(reason),
                    item_id,
                ),
            )

        connection.commit()
        return update

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def claim_due_retries(job_id, now=None):
    """Re-attach unpublished retry_pending items that are due to this
    job as 'pending' so the normal stages pick them up again.

    Idempotent: only items whose next_retry_at has passed move, and
    retry_count is preserved so the backoff/maximum still applies.
    Returns the number of items claimed.
    """
    now = now or datetime.now(timezone.utc)
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_items
                SET job_id = %s,
                    status = 'pending',
                    updated_at = NOW()
                WHERE status = 'retry_pending'
                  AND song_id IS NULL
                  AND next_retry_at IS NOT NULL
                  AND next_retry_at <= %s;
                """,
                (job_id, now),
            )
            claimed = cursor.rowcount

        connection.commit()
        return claimed

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


def clear_item_retry_state(item_id):
    """Reset retry bookkeeping after a successful step."""
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE import_items
                SET error_category = NULL,
                    next_retry_at = NULL,
                    updated_at = NOW()
                WHERE id = %s;
                """,
                (item_id,),
            )

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()


if __name__ == "__main__":
    test_connection()
