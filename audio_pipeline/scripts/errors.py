"""Explicit error categories for the audio pipeline.

The key rule enforced here: only a problem with the *media itself*
(INVALID_MEDIA) may mark a song as failed. Anything caused by tools,
the network, the database or the host is an infrastructure problem and
must never change a song's state to failed or move it to FAILED.
"""

import enum
import socket
import subprocess


class ErrorCategory(str, enum.Enum):
    # The audio file itself is corrupt/unreadable. Only category that
    # may result in status 'failed'.
    INVALID_MEDIA = "INVALID_MEDIA"
    # Missing tool, bad config, unknown bug. Halts the run; no item changes.
    SYSTEM_ERROR = "SYSTEM_ERROR"
    # Timeout/outage that is expected to recover. Item is scheduled to retry.
    TRANSIENT_ERROR = "TRANSIENT_ERROR"
    # Same content was verifiably imported before.
    DUPLICATE_VERIFIED = "DUPLICATE_VERIFIED"
    # Item waits for its next retry time.
    RETRY_PENDING = "RETRY_PENDING"
    # A human must decide (ambiguous album, missing file, retries exhausted).
    MANUAL_REVIEW = "MANUAL_REVIEW"


# Only these categories may ever mark an item 'failed'.
FAILURE_ALLOWED = frozenset({ErrorCategory.INVALID_MEDIA})
# These categories must halt the run instead of touching items.
HALTING = frozenset({ErrorCategory.SYSTEM_ERROR})


class PipelineError(Exception):
    category = ErrorCategory.SYSTEM_ERROR

    def __init__(self, message, category=None):
        super().__init__(message)
        if category is not None:
            self.category = category


class MissingDependencyError(PipelineError):
    """A required executable (ffprobe/ffmpeg) is not available."""

    category = ErrorCategory.SYSTEM_ERROR


class InvalidMediaError(PipelineError):
    category = ErrorCategory.INVALID_MEDIA


class AudioFileMissingError(PipelineError):
    """The audio file path does not exist. A human decides; this is
    not proof that the media is corrupt."""

    category = ErrorCategory.MANUAL_REVIEW


class TransientError(PipelineError):
    category = ErrorCategory.TRANSIENT_ERROR


class AmbiguousAlbumError(PipelineError):
    category = ErrorCategory.MANUAL_REVIEW


class ManualReviewError(PipelineError):
    category = ErrorCategory.MANUAL_REVIEW


def _is_db_transient(error):
    try:
        import psycopg2
    except ImportError:  # pragma: no cover - psycopg2 is a requirement
        return False

    return isinstance(
        error,
        (psycopg2.OperationalError, psycopg2.InterfaceError),
    )


def classify_exception(error):
    """Map any exception to an ErrorCategory.

    Unknown exceptions are SYSTEM_ERROR (halt, change nothing): the safe
    default. They are never treated as invalid media.
    """
    if isinstance(error, PipelineError):
        return error.category

    if isinstance(
        error,
        (
            TimeoutError,
            socket.timeout,
            ConnectionError,
            subprocess.TimeoutExpired,
        ),
    ):
        return ErrorCategory.TRANSIENT_ERROR

    # urllib / http style errors without importing hard dependencies.
    if type(error).__name__ in {"URLError", "RemoteDisconnected"}:
        return ErrorCategory.TRANSIENT_ERROR

    if _is_db_transient(error):
        return ErrorCategory.TRANSIENT_ERROR

    if isinstance(error, (ValueError, FileNotFoundError)):
        # Bad/missing metadata or path: needs a human, not a 'failed'.
        return ErrorCategory.MANUAL_REVIEW

    return ErrorCategory.SYSTEM_ERROR


def may_mark_failed(category):
    return category in FAILURE_ALLOWED
