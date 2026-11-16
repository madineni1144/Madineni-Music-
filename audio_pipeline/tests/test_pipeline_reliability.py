import subprocess
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import psycopg2
import pytest

from audio_pipeline.scripts import (
    album_policy,
    archive_drive,
    drive_policy,
    validate_audio,
)
from audio_pipeline.scripts.dependencies import require_executables
from audio_pipeline.scripts.errors import (
    AmbiguousAlbumError,
    AudioFileMissingError,
    ErrorCategory,
    InvalidMediaError,
    MissingDependencyError,
    TransientError,
    classify_exception,
    may_mark_failed,
)
from audio_pipeline.scripts.item_state import plan_error_update
from audio_pipeline.scripts.retry_policy import (
    RetryPolicy,
    backoff_seconds,
    call_with_retries,
    is_due,
)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


# ---- 1/2: missing ffprobe vs missing audio vs corrupt audio ----------

def test_missing_ffprobe_executable_halts_without_marking_failed():
    with pytest.raises(MissingDependencyError) as info:
        require_executables(("ffprobe",), which=lambda name: None)
    assert classify_exception(info.value) == ErrorCategory.SYSTEM_ERROR
    assert not may_mark_failed(ErrorCategory.SYSTEM_ERROR)


def test_ffprobe_not_found_at_runtime_is_system_error_not_media(monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError("ffprobe")
    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(MissingDependencyError) as info:
        validate_audio.probe_audio("/synthetic/song.mp3")
    assert classify_exception(info.value) == ErrorCategory.SYSTEM_ERROR


def test_system_error_never_changes_any_item():
    with pytest.raises(Exception):
        plan_error_update(
            status="pending", song_id=None, retry_count=0,
            category=ErrorCategory.SYSTEM_ERROR,
        )


def test_missing_audio_file_is_manual_review_not_failed(tmp_path):
    item = {
        "id": 1, "original_filename": "x.mp3",
        "local_file_path": str(tmp_path / "gone.mp3"),
    }
    with pytest.raises(AudioFileMissingError) as info:
        validate_audio.validate_item(item)
    assert classify_exception(info.value) == ErrorCategory.MANUAL_REVIEW
    update = plan_error_update(
        status="pending", song_id=None, retry_count=0,
        category=ErrorCategory.MANUAL_REVIEW,
    )
    assert update["status"] == "manual_review"


def test_corrupt_audio_is_invalid_media_and_only_then_failed(monkeypatch):
    fake = SimpleNamespace(returncode=1, stdout="", stderr="Invalid data")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: fake)
    with pytest.raises(InvalidMediaError) as info:
        validate_audio.probe_audio("/synthetic/corrupt.mp3")
    category = classify_exception(info.value)
    assert category == ErrorCategory.INVALID_MEDIA
    update = plan_error_update(
        status="pending", song_id=None, retry_count=0, category=category,
    )
    assert update["status"] == "failed"


# ---- 3: API timeout / database outage are transient ------------------

def test_api_timeout_is_transient_and_scheduled_for_retry():
    category = classify_exception(TimeoutError("playback timed out"))
    assert category == ErrorCategory.TRANSIENT_ERROR
    update = plan_error_update(
        status="validated", song_id=None, retry_count=0,
        category=category, now=NOW,
    )
    assert update["status"] == "retry_pending"
    assert update["next_retry_at"] > NOW
    assert update["status"] != "failed"


def test_database_outage_is_transient_not_invalid_media():
    category = classify_exception(psycopg2.OperationalError("down"))
    assert category == ErrorCategory.TRANSIENT_ERROR
    assert not may_mark_failed(category)


def test_unknown_exception_halts_instead_of_failing_songs():
    assert classify_exception(KeyError("x")) == ErrorCategory.SYSTEM_ERROR


# ---- retry exhaustion & persisted backoff ----------------------------

def test_backoff_is_exponential_and_capped():
    policy = RetryPolicy(max_attempts=10, base_seconds=10, max_seconds=100)
    assert [backoff_seconds(n, policy) for n in (1, 2, 3, 4, 5)] == [
        10, 20, 40, 80, 100,
    ]


def test_retry_exhaustion_goes_to_manual_review_never_failed():
    policy = RetryPolicy(max_attempts=2, base_seconds=1, max_seconds=10)
    count = 0
    statuses = []
    for _ in range(3):
        update = plan_error_update(
            status="validated", song_id=None, retry_count=count,
            category=ErrorCategory.TRANSIENT_ERROR, now=NOW, policy=policy,
        )
        count = update["retry_count"]
        statuses.append(update["status"])
    assert statuses == ["retry_pending", "retry_pending", "manual_review"]
    assert update["next_retry_at"] is None
    assert "failed" not in statuses


def test_retry_state_is_persisted_values_not_in_memory():
    first = plan_error_update(
        status="pending", song_id=None, retry_count=0,
        category=ErrorCategory.TRANSIENT_ERROR, now=NOW,
    )
    # A later run starts from the stored retry_count, not from zero.
    second = plan_error_update(
        status="pending", song_id=None, retry_count=first["retry_count"],
        category=ErrorCategory.TRANSIENT_ERROR, now=NOW,
    )
    assert second["retry_count"] == 2
    assert not is_due(second["next_retry_at"], now=NOW)
    assert is_due(second["next_retry_at"], now=NOW + timedelta(days=1))


def test_in_process_retry_is_bounded_and_only_for_transient():
    calls = []

    def flaky():
        calls.append(1)
        raise TransientError("t")

    with pytest.raises(TransientError):
        call_with_retries(
            flaky, is_transient=lambda e: isinstance(e, TransientError),
            attempts=3, sleep=lambda s: None,
        )
    assert len(calls) == 3

    calls.clear()

    def invalid():
        calls.append(1)
        raise InvalidMediaError("bad")

    with pytest.raises(InvalidMediaError):
        call_with_retries(
            invalid, is_transient=lambda e: isinstance(e, TransientError),
            attempts=3, sleep=lambda s: None,
        )
    assert len(calls) == 1


# ---- 4: interrupted publication --------------------------------------

def test_timeout_after_publication_keeps_song_and_item_consistent():
    # Song is already published (song_id set) when playback times out.
    update = plan_error_update(
        status="validated", song_id=42, retry_count=0,
        category=ErrorCategory.TRANSIENT_ERROR, now=NOW,
    )
    assert update["status"] == "validated"      # not 'failed'
    assert update["next_retry_at"] is not None  # will be retried
    item = {
        "status": update["status"], "playback_validated": None,
        "song_id": 42, "error_category": update["error_category"],
    }
    # Drive file stays in INCOMING: no contradiction with the library.
    assert drive_policy.route_for_item(item) == drive_policy.KEEP


def test_published_song_is_never_marked_failed_even_if_invalid():
    update = plan_error_update(
        status="validated", song_id=42, retry_count=0,
        category=ErrorCategory.INVALID_MEDIA,
    )
    assert update["status"] == "manual_review"


# ---- 5: duplicates -----------------------------------------------------

def test_previously_failed_attempt_is_not_a_verified_duplicate():
    # Policy mirrored from db.find_duplicate_by_sha256: only imported
    # (song_id) or same-job in-flight rows count.
    def verified(row, job_id):
        return row["song_id"] is not None or (
            row["job_id"] == job_id
            and row["status"] in ("pending", "validated", "warning")
        )

    failed_before = {"song_id": None, "job_id": 1, "status": "failed"}
    imported = {"song_id": 7, "job_id": 1, "status": "validated"}
    in_flight_same_job = {"song_id": None, "job_id": 2, "status": "pending"}
    assert not verified(failed_before, job_id=2)
    assert verified(imported, job_id=2)
    assert verified(in_flight_same_job, job_id=2)


def test_db_duplicate_query_excludes_failed_attempts():
    import inspect
    from audio_pipeline.scripts import db
    source = inspect.getsource(db.find_duplicate_by_sha256)
    assert "song_id IS NOT NULL" in source
    assert "'failed'" not in source


# ---- 6: metadata preservation ----------------------------------------

def test_error_update_never_touches_metadata_columns():
    update = plan_error_update(
        status="validated", song_id=None, retry_count=0,
        category=ErrorCategory.TRANSIENT_ERROR, now=NOW,
    )
    assert set(update) == {
        "status", "error_category", "retry_count", "next_retry_at",
    }


def test_validation_and_error_sql_preserve_metadata():
    import inspect
    from audio_pipeline.scripts import db
    validation = inspect.getsource(db.update_import_item_validation)
    assert "title = COALESCE(%s, title)" in validation
    assert "artist = COALESCE(%s, artist)" in validation
    assert "album = COALESCE(%s, album)" in validation
    assert "original_metadata" in validation
    errors = inspect.getsource(db.record_item_error)
    for column in ("title", "artist", "album", "drive_file_id", "sha256"):
        assert f"{column} =" not in errors


# ---- 7: albums ---------------------------------------------------------

def test_same_album_name_different_artists_not_merged():
    existing = [(10, "Greatest Hits", 1)]
    decision, album_id = album_policy.choose_album(
        existing, "greatest hits", artist_id=2
    )
    assert decision == album_policy.CREATE and album_id is None


def test_same_album_same_artist_reused():
    existing = [(10, "Greatest Hits", 1)]
    assert album_policy.choose_album(
        existing, "Greatest Hits", artist_id=1
    ) == (album_policy.REUSE, 10)


def test_album_with_unknown_artist_is_flagged_for_manual_review():
    existing = [(10, "Greatest Hits", None)]
    decision, _ = album_policy.choose_album(
        existing, "Greatest Hits", artist_id=1
    )
    assert decision == album_policy.AMBIGUOUS
    assert classify_exception(AmbiguousAlbumError("x")) == (
        ErrorCategory.MANUAL_REVIEW
    )


# ---- 10: Google Drive --------------------------------------------------

INCOMING = archive_drive.INCOMING_FOLDER_ID
ARCHIVE = archive_drive.ARCHIVE_FOLDER_ID
FAILED = archive_drive.FAILED_FOLDER_ID


class FakeDrive:
    """Synthetic Drive. Records every write; can fail mid-move."""

    def __init__(self, files, fail_on_update=False, partial=False):
        self.files_state = files
        self.fail_on_update = fail_on_update
        self.partial = partial
        self.writes = []

    def files(self):
        return self

    def get(self, fileId, fields=None):
        return _Req(lambda: dict(self.files_state[fileId], id=fileId))

    def update(self, fileId, addParents=None, removeParents=None,
               fields=None):
        def run():
            if self.fail_on_update:
                raise ConnectionError("drive 503")
            self.writes.append((fileId, addParents, removeParents))
            parents = list(self.files_state[fileId]["parents"])
            if addParents:
                parents.append(addParents)
            if self.partial and addParents and removeParents:
                self.files_state[fileId]["parents"] = parents
                return {"id": fileId, "parents": parents}
            if removeParents:
                parents = [p for p in parents if p != removeParents]
            self.files_state[fileId]["parents"] = parents
            return {"id": fileId, "parents": parents}
        return _Req(run)


class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


def _item(**kw):
    base = {
        "id": 1, "drive_file_id": "f1", "filename": "a.mp3",
        "status": "validated", "playback_validated": True,
        "song_id": 5, "error_category": None, "failure_reason": None,
    }
    base.update(kw)
    return base


def test_infrastructure_errors_never_route_to_failed_folder():
    for category in ("SYSTEM_ERROR", "TRANSIENT_ERROR", "MANUAL_REVIEW",
                     "RETRY_PENDING"):
        for status in ("failed", "retry_pending", "manual_review",
                       "pending"):
            item = {"status": status, "playback_validated": None,
                    "song_id": None, "error_category": category}
            assert drive_policy.route_for_item(item) == drive_policy.KEEP


def test_only_verified_invalid_media_unpublished_goes_to_failed():
    ok = {"status": "failed", "playback_validated": None,
          "song_id": None, "error_category": "INVALID_MEDIA"}
    assert drive_policy.route_for_item(ok) == drive_policy.FAILED
    published = dict(ok, song_id=3)
    assert drive_policy.route_for_item(published) == drive_policy.KEEP


def test_drive_moves_require_authorization_dry_run_writes_nothing():
    drive = FakeDrive({"f1": {"parents": [INCOMING], "trashed": False}})
    counts = archive_drive.route_items(drive, [_item()], authorized=False)
    assert drive.writes == []
    assert counts["dry_run"] == 1


def test_authorized_move_is_idempotent_on_repeat():
    drive = FakeDrive({"f1": {"parents": [INCOMING], "trashed": False}})
    first = archive_drive.route_items(drive, [_item()], authorized=True)
    second = archive_drive.route_items(drive, [_item()], authorized=True)
    assert first["archived"] == 1
    assert second["already"] == 1 and second["archived"] == 0
    assert len(drive.writes) == 1


def test_drive_move_failure_leaves_file_recoverable_and_db_untouched():
    drive = FakeDrive(
        {"f1": {"parents": [INCOMING], "trashed": False}},
        fail_on_update=True,
    )
    counts = archive_drive.route_items(drive, [_item()], authorized=True)
    assert counts["errors"] == 1
    assert drive.files_state["f1"]["parents"] == [INCOMING]


def test_partial_drive_move_is_finished_next_run():
    drive = FakeDrive(
        {"f1": {"parents": [INCOMING], "trashed": False}}, partial=True,
    )
    first = archive_drive.route_items(drive, [_item()], authorized=True)
    assert first["errors"] == 1  # not confirmed
    assert set(drive.files_state["f1"]["parents"]) == {INCOMING, ARCHIVE}
    drive.partial = False
    second = archive_drive.route_items(drive, [_item()], authorized=True)
    assert second["archived"] == 1
    assert drive.files_state["f1"]["parents"] == [ARCHIVE]


def test_trashed_file_is_skipped_not_an_error():
    drive = FakeDrive({"f1": {"parents": [INCOMING], "trashed": True}})
    counts = archive_drive.route_items(drive, [_item()], authorized=True)
    assert counts["skipped"] == 1 and counts["errors"] == 0


# ---- 12: repeated execution of the same item ---------------------------

def test_repeating_error_planning_is_deterministic_and_bounded():
    kwargs = dict(
        status="pending", song_id=None, retry_count=1,
        category=ErrorCategory.TRANSIENT_ERROR, now=NOW,
    )
    assert plan_error_update(**kwargs) == plan_error_update(**kwargs)


def test_duplicate_verified_is_terminal_and_stable():
    first = plan_error_update(
        status="pending", song_id=None, retry_count=0,
        category=ErrorCategory.DUPLICATE_VERIFIED,
    )
    second = plan_error_update(
        status=first["status"], song_id=None, retry_count=0,
        category=ErrorCategory.DUPLICATE_VERIFIED,
    )
    assert first == second and first["status"] == "duplicate"


# ---- 9: v2 removed, no references -------------------------------------

def test_store_audio_v2_removed_and_unreferenced():
    from pathlib import Path
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    assert not (scripts / "store_audio_v2.py").exists()
    for path in scripts.glob("*.py"):
        assert "store_audio_v2" not in path.read_text()
