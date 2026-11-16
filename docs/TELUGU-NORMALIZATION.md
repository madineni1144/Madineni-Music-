# Telugu / Indic normalisation fix

**Bug (confirmed by tests):** `lyrics-core.normalize()` replaced everything outside `\p{L}\p{N}` with a space. Telugu vowel signs, virama and anusvara are combining marks (`\p{M}`), so Telugu words were split into single letters and different words collided: `శ్రీమంతుడు` became `శ ర మ త డ`, and `గీత`/`గిత`, `కి`/`కు` normalised identically.

**Fix:** keep `\p{M}`; remove ZWNJ/ZWJ (glyph shaping, never a boundary) instead of turning them into spaces. Spaces, punctuation and zero-width *space* remain boundaries. Latin behaviour is unchanged: tested against a frozen copy of the old function on a corpus plus 4,000 deterministic fuzz strings.

## What changes, what does not
| Item | Changes? |
|---|---|
| `fingerprint()` / `madineni_song_lyrics.fingerprint` (cache identity) | **No.** It hashes `clean()` output (NFKC only), never `normalize()`. Golden hashes recorded before the change are asserted in `lyrics-normalize.test.js`. Existing cache rows stay valid; nothing is invalidated, migrated or rewritten. |
| `matchScore` / `pickMatch` for Latin titles | No (identical outputs). |
| `matchScore` / `pickMatch` for Telugu (and other mark-bearing scripts: Devanagari, Tamil, ...) | **Yes, only when a song is looked up again** (cache miss, expiry or manual refresh): fewer false positives where words differed only by a vowel sign, and substring-containment length checks now count marks. Already-cached rows are not re-evaluated. |
| Production caches / data | Not touched by this change. Nothing in it reads or writes the database. |

## Follow-ups (not done here)
- After this merges, the metadata branch's private mark-preserving `fold()` in `backend/metadata/matcher.js` can be removed.
- Whether to proactively re-match Telugu songs already cached as `not_found` is a product decision; it would be a read-only report first, then a separately approved refresh.
