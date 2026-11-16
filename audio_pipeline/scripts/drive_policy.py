"""Pure decision logic for Google Drive routing.

Safety invariants (enforced here and covered by tests):
- A file is moved to FAILED only for verified INVALID_MEDIA that was
  never published. Infrastructure problems never route to FAILED.
- A published song (song_id set) is never moved to FAILED.
- Moves are idempotent and finish a half-completed move.
"""

from audio_pipeline.scripts.errors import ErrorCategory

KEEP = "KEEP"
ARCHIVE = "ARCHIVE"
ARCHIVE_DUPLICATE = "ARCHIVE_DUPLICATE"
FAILED = "FAILED"


def route_for_item(item):
    """Return the routing action for an import item dict.

    item keys: status, playback_validated, song_id, error_category.
    """
    status = item["status"]
    category = item.get("error_category")

    if status in ("validated", "warning"):
        if item.get("playback_validated") is True:
            return ARCHIVE
        return KEEP

    if status == "duplicate":
        return ARCHIVE_DUPLICATE

    if (
        status == "failed"
        and category == ErrorCategory.INVALID_MEDIA.value
        and item.get("song_id") is None
    ):
        return FAILED

    # retry_pending, manual_review, pending, failed without verified
    # INVALID_MEDIA, or anything unknown: leave the file where it is.
    return KEEP


MOVE = "MOVE"
FINISH_REMOVE = "FINISH_REMOVE"
ALREADY_DONE = "ALREADY_DONE"
SKIP = "SKIP"


def plan_move(parents, incoming_id, destination_id, trashed=False):
    """Decide the next Drive step from the file's current parents.

    Handles a partially applied earlier move (file has both parents).
    """
    if trashed:
        return SKIP

    parents = set(parents or [])

    if destination_id in parents and incoming_id in parents:
        return FINISH_REMOVE

    if destination_id in parents:
        return ALREADY_DONE

    if incoming_id in parents:
        return MOVE

    # Somewhere else entirely; do not touch.
    return SKIP
