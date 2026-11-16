# Merge sequence for PRs #5, #6 and #4 (nothing has been merged)

PR #5 `fix/backend-hardening` -> `main`. PR #6 `fix/telugu-normalization` and PR #4
`feat/metadata-investigation` are drafts stacked on the hardening branch.

## Order

1. **Review and merge #5 first.** Before merging, confirm on its *current* head (not an earlier one):
   the five required checks are green with that head SHA, and the head is up to date with `main`.
   Use a **merge commit** (not squash or rebase). #6 and #4 already contain the hardening commits;
   a merge commit keeps those commits identical on `main`, so their remaining diffs shrink to their own
   changes. A squash merge rewrites the history, and each stacked branch would then show the hardening
   changes again and conflict until `main` is merged into it.
2. **Retarget #6 and #4 to `main`** (UI "Edit" next to the base branch, or
   `gh api -X PATCH repos/madineni1144/Madineni-Music-/pulls/<n> -f base=main`). Keep them draft.
3. **Update each branch with `main` by merging `main` into it** (no force-push). This is what creates a
   *new head*, and therefore a fresh CI run against the new base. Do not accept a re-run of an older
   workflow run as evidence: changing the base branch alone does not create a new head.
4. **Inspect each resulting diff against `main`** (`git diff --stat origin/main...<branch>`, or the PR
   Files tab) and compare it with the expected lists below. Anything extra means the base was not what
   was assumed; stop and investigate.
5. **Rerun CI on the exact new head** and record head SHA, run URL, and counts from the job logs
   (`# tests / # pass / # fail / # skipped / # todo`). Counts from an earlier head do not carry over.
6. **Merge #6 (Telugu) before #4 (metadata)**, so the metadata branch can use the shared normaliser.
7. **Assess removing the metadata matcher's duplicate normalisation** (see below) in a separate commit
   on #4, with regression tests, after #6 is on `main` and merged into #4. Do not do this before.

## Expected diffs against `main` once #5 is merged

- #6: `backend/lyrics-core.cjs` (normalize + export line), `backend/test/lyrics-normalize.test.js`,
  `docs/TELUGU-NORMALIZATION.md` - three files.
- #4: the metadata files only (`backend/metadata/**`, `backend/test/metadata.test.js`,
  `scripts/metadata-investigate.js`, `docs/METADATA-ENRICHMENT.md`, `docs/samples/metadata-review/*`,
  `.env.example` names, the `lyrics-core.cjs` export line - which #6 duplicates identically, so Git
  merges it cleanly - and the metadata-related lines of `docs/DEPLOYMENT.md`). No file under
  `backend/server.js`, `backend/http-utils.js`, `backend/proxy.js` or `.github/` should appear.

## The duplicate normalisation workaround (measured on a scratch merge; nothing pushed)

`backend/metadata/matcher.js` routes any string containing a non-Latin character through its own
`fold()` instead of the shared `normalize()/titleKey()/albumKey()`, because the shared function used to
turn Telugu vowel signs into spaces. A scratch merge of #6 into #4 (not pushed) was used to measure what
removing that workaround would do. Corpus: 21 strings (Telugu titles, artist and album text, Devanagari,
Tamil, mixed script, Latin) through three functions.

- **It is not a pure duplicate.** 20 of 63 (function, input) pairs differ. In every differing pair the
  shared function removes something `fold()` keeps: a leading track number (`01. `), a file extension
  (`.mp3`), a bitrate (`320kbps`), `(From "...")`, `(feat. ...)`, `- Deluxe`, `(Original Motion Picture
  Soundtrack)`. It also joins `క్ష‍త్రియ` (written with a zero-width joiner), which `fold()` splits into `క్ష త్రియ`.
  So non-Latin titles are currently compared less cleanly than Latin ones; removal makes them consistent.
- **It is a behaviour change**, not a refactor, for non-Latin input that carries those decorations:
  edition words in non-Latin album titles would stop counting as differences, as they already do for Latin.
- With `fold()` replaced by the shared functions, `node scripts/metadata-investigate.js` output was
  byte-identical to `docs/samples/metadata-review` (the fixtures contain no decorated non-Latin strings, so
  that proves nothing about decorated input). Add fixtures/tests for the cases above before relying on it.
- **Landmine for the merge itself:** `backend/test/metadata.test.js` (the "Telugu script" test) asserts
  `lyrics-core.normalize("గీత") === "గ త"` - i.e. it asserts the bug #6 fixes. After #6 is merged into #4 that
  test fails, with or without `fold()` removed (reproduced on the scratch merge: 27 of 28 pass, 1 fail).
  #4 carries a commit that removes the coupling (the test now asserts the matcher's own result, which is
  the same before and after #6), so the merge into #4 stays green.

Plan after #6 is on `main` and merged into #4: replace the `safe(...)` wrappers with the shared functions in
one commit; add regression tests for each category above (decorated Telugu title, album edition suffix,
ZWJ word, Latin unchanged) asserting the *intended* new outputs; run `metadata.test.js` and the fixture
diff. If a decision is made to keep non-Latin comparison strict (decorations significant), keep `fold()`
and say why in the code comment.
