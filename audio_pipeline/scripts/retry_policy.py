"""Bounded exponential backoff with retry state that survives runs.

State lives on the import item (retry_count, next_retry_at), so a retry
after a crash or a new Airflow run continues the same schedule instead
of restarting it.
"""

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from audio_pipeline.scripts.errors import ErrorCategory


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 5
    base_seconds: int = 300
    max_seconds: int = 6 * 3600


DEFAULT_POLICY = RetryPolicy()


def backoff_seconds(attempt, policy=DEFAULT_POLICY):
    """Delay before retry number `attempt` (1-based), capped."""
    if attempt < 1:
        attempt = 1
    delay = policy.base_seconds * (2 ** (attempt - 1))
    return min(delay, policy.max_seconds)


def next_state(retry_count, now=None, policy=DEFAULT_POLICY):
    """Compute the persisted state after one more transient failure.

    Returns (category, new_retry_count, next_retry_at). When attempts are
    exhausted the item goes to MANUAL_REVIEW and next_retry_at is None.
    """
    now = now or datetime.now(timezone.utc)
    new_count = (retry_count or 0) + 1

    if new_count > policy.max_attempts:
        return ErrorCategory.MANUAL_REVIEW, new_count, None

    return (
        ErrorCategory.RETRY_PENDING,
        new_count,
        now + timedelta(seconds=backoff_seconds(new_count, policy)),
    )


def is_due(next_retry_at, now=None):
    now = now or datetime.now(timezone.utc)
    return next_retry_at is None or next_retry_at <= now


def call_with_retries(
    function,
    *,
    is_transient,
    attempts=3,
    base_seconds=1.0,
    max_seconds=30.0,
    sleep=time.sleep,
):
    """Bounded in-process retries for a short, idempotent call.

    Only exceptions for which is_transient(error) is true are retried.
    The last error is re-raised once attempts run out.
    """
    for attempt in range(1, attempts + 1):
        try:
            return function()
        except Exception as error:
            if not is_transient(error) or attempt == attempts:
                raise
            sleep(min(base_seconds * (2 ** (attempt - 1)), max_seconds))
