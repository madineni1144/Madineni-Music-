"""Decide whether an incoming album matches an existing album.

Albums are never merged on title alone. Existing rows are never
modified; the decision is only reuse, create, or ask a human.
"""

REUSE = "reuse"
CREATE = "create"
AMBIGUOUS = "ambiguous"


def _norm(value):
    return " ".join(str(value or "").split()).casefold()


def choose_album(candidates, title, artist_id):
    """candidates: iterable of (album_id, album_title, album_artist_id).

    - exactly one same-title album owned by this artist -> reuse it
    - more than one same-title album for this artist    -> ambiguous
    - same-title album(s) with no artist recorded        -> ambiguous
      (cannot prove they are the same release)
    - same-title albums only for other artists           -> create new
    - nothing with that title                            -> create new
    """
    same_title = [
        row for row in candidates if _norm(row[1]) == _norm(title)
    ]

    mine = [row for row in same_title if row[2] == artist_id]
    unowned = [row for row in same_title if row[2] is None]

    if len(mine) == 1 and not unowned:
        return REUSE, mine[0][0]

    if len(mine) > 1 or unowned:
        return AMBIGUOUS, None

    return CREATE, None
