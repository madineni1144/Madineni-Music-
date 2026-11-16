"""Pure state-transition rules for recording an error on an import item.

db.record_item_error applies the dict returned here. Keeping the rules
free of database code makes the safety guarantees directly testable.
"""

from audio_pipeline.scripts.errors import (
    ErrorCategory,
    PipelineError,
)
from audio_pipeline.scripts.retry_policy import (
    DEFAULT_POLICY,
    next_state,
)

PUBLISHED_ACTIVE = ("validated", "warning")


def plan_error_update(
    *,
    status,
    song_id,
    retry_count,
    category,
    now=None,
    policy=DEFAULT_POLICY,
):
    """Return the columns to write: status, error_category,
    retry_count, next_retry_at.

    Guarantees:
    - SYSTEM_ERROR never produces an update (the run must halt).
    - 'failed' only for INVALID_MEDIA on an unpublished item.
    - A published item (song_id set) is never marked failed.
    - Transient errors retry with bounded backoff, then MANUAL_REVIEW.
    """
    category = ErrorCategory(category)

    if category == ErrorCategory.SYSTEM_ERROR:
        raise PipelineError(
            "SYSTEM_ERROR must halt the run; item not modified.",
            ErrorCategory.SYSTEM_ERROR,
        )

    if category == ErrorCategory.DUPLICATE_VERIFIED:
        return {
            "status": "duplicate",
            "error_category": category.value,
            "retry_count": retry_count or 0,
            "next_retry_at": None,
        }

    if category == ErrorCategory.INVALID_MEDIA:
        if song_id is not None:
            category = ErrorCategory.MANUAL_REVIEW
        else:
            return {
                "status": "failed",
                "error_category": ErrorCategory.INVALID_MEDIA.value,
                "retry_count": retry_count or 0,
                "next_retry_at": None,
            }

    if category in (
        ErrorCategory.TRANSIENT_ERROR,
        ErrorCategory.RETRY_PENDING,
    ):
        new_category, count, when = next_state(
            retry_count, now=now, policy=policy
        )

        if new_category == ErrorCategory.MANUAL_REVIEW:
            return {
                "status": "manual_review",
                "error_category": ErrorCategory.MANUAL_REVIEW.value,
                "retry_count": count,
                "next_retry_at": None,
            }

        return {
            # Published items keep their status; the retry fields drive
            # the next attempt. Unpublished items wait as retry_pending.
            "status": status if song_id is not None else "retry_pending",
            "error_category": ErrorCategory.TRANSIENT_ERROR.value,
            "retry_count": count,
            "next_retry_at": when,
        }

    # MANUAL_REVIEW
    return {
        "status": "manual_review",
        "error_category": ErrorCategory.MANUAL_REVIEW.value,
        "retry_count": retry_count or 0,
        "next_retry_at": None,
    }
