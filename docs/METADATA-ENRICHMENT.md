# Metadata enrichment: audit, provider decisions, usage

Status: development branch only. Nothing deployed, merged, migrated or run against production data.
Ingestion (legacy + v2) stays paused. External artwork verification stays disabled (mock/fixtures only).

## 1. Current state (evidence from the repo)

| Area | State | Evidence |
|---|---|---|
| Album rows created by pipeline | Incomplete: artist, year, cover all NULL | `audio_pipeline/scripts/register_songs.py` (`INSERT INTO albums ... VALUES (%s, NULL, NULL, NULL)`) |
| Title/artist/album normalisation | Implemented (reused here) | `backend/lyrics-core.cjs`, `audio_pipeline/scripts/normalize_metadata.py` |
| Lyrics lookup + cache | Implemented (retrieval only) | `backend/lyrics-core.cjs`, `madineni_song_lyrics` table |
| Artwork audit/verification | Missing | no code in repo |
| Artist bios, cross-platform links, listening history, provider monitoring | Missing | no code in repo |
| Release/album identification | Missing before this branch | now `backend/metadata/` |
| Database schema | Not in repo (inferred from queries) | needs read-only check on the server |
| AI-AGENT platform | `AI-AGENT-` repo is empty. `M-M-AI-Monitoring-` is a read-only dashboard. `jarvis` (Gideon) is a real agent platform (providers, budget, SQLite audit, tool registry) | inspected read-only |
| `/home/rk/Music-App`, `/opt/musicapp/app` roles | Unverified: no server access from this session | do not assume either is live |

## 2. Gap table (public-apis used as discovery only)

**This comparison is INCOMPLETE.** The public-apis README (Music and MCP Servers sections) could not be fetched in two sessions (hosts not on the fetch allowlist), so those sections were **not** reviewed and no catalogue-derived candidate is excluded or included on that basis. Re-do this step when access exists. Providers were taken from your brief and verified individually through search results from their own docs/terms where available.

| Existing capability | Verified gap | Candidate provider | Required development | Cost/access | Priority |
|---|---|---|---|---|---|
| Album rows with NULL artist/year/cover | Album details missing | MusicBrainz | Done here (adapter, matcher, report) | Free, no key; 1 req/s, User-Agent mandatory; core data CC0 | P0 (built) |
| Cover paths only | No artwork check | Cover Art Archive via MB IDs (not verified) / iTunes | Mock only; live disabled | iTunes ~20 calls/min; artwork rights unverified | P2 (blocked by your rule) |
| No bios | Artist bios | TheAudioDB / Last.fm | Adapter + licence review | TheAudioDB test key 123 at 30 req/min; premium $8/mo for 100/min; Last.fm non-commercial by default, contact for commercial use | P2 |
| Lyrics exist (retrieval) | Coverage fallbacks | Musixmatch | Not recommended now | Free tier returns ~30% previews; full text needs a commercial licence | P3 |
| None | Cross-platform links | Songlink/Odesli | **Excluded from decisions** | Access terms are UNVERIFIED (conflicting secondhand reports; no official page read) | Undecided |
| None | Listening history/recs | ListenBrainz | Needs user tokens + product decision | Free; token auth; rate-limit headers | P3 |
| None | Radio/concerts | Radio Browser, Bandsintown, Songkick | Skip | Bandsintown only for artists or their representatives with written consent; Songkick reported not granting new keys | Not justified |
| Discogs | Indian release coverage unknown | Discogs | Defer until MB coverage measured | Auth 60/min; some data restricted by API terms | P2 |

Telugu/Indian coverage: MusicBrainz does hold Telugu soundtrack releases and release groups (spot-found via search), but coverage completeness is **unmeasured**. Run the sample against real albums before relying on it.

## 3. Commands

```
cd backend && npm ci && npm test            # CI-equivalent: must show 0 skipped / 0 todo
node scripts/metadata-investigate.js --out /tmp/review                 # five synthetic fixtures, no network, fixed clock
diff -r /tmp/review docs/samples/metadata-review && echo reproducible  # committed sample
# Live (needs separate approval): MUSICAPP_METADATA_LIVE=1 MUSICBRAINZ_USER_AGENT='App/1.0 (contact)' \
#   node scripts/metadata-investigate.js --live --sample sample.json   # <=5 albums, read-only
```

## 4. Agent integration

`createInvestigationTools()` exposes three read-only tools (`investigate_album`, `compare_metadata`, `generate_report`) with a manifest, provider-call and album limits, an audit log of every call/failure, input validation and sanitisation of external text. Mode is recommend-fixes; no write tool exists. Lyrics are retrieval-only; nothing here generates lyrics.
The tools are deterministic (no model). To call them from Gideon, register thin wrappers in `gideon/tools.py` that shell out to the CLI or a small Node bridge; this branch does **not** modify the Gideon repo. Model use and spend limits then come from Gideon's existing `Budget`.

## 5. Remaining work

Authenticated before/after review screen (reuse `MUSICAPP_WRITE_TOKEN` guard); read-only schema check on the server; measured Telugu coverage on a permitted sample; Cover Art Archive review; bios provider after licence decision; any apply step (separate approval, migration SQL not written).

## 6. Reproducing the sample

Inputs: `backend/metadata/fixtures/sample-input.json` (5 synthetic albums) and `provider-responses.json` (fake MusicBrainz-shaped replies, fake MBIDs `00000000-0000-4000-8000-...`). Committed output: `docs/samples/metadata-review/{report.md,report.json,audit.jsonl}`. A test fails if the committed sample or JSON fixtures drift from the code.

## 7. Matching rules (conservative by design)

- Confidence = weighted sum with **missing evidence counted as zero** (never renormalised). Weights: title .30, tracks .30, artist .15, year .10, language .10, duration .05.
- `clear` requires title ≥ .9, artist ≥ .9, tracks ≥ .7, **known and agreeing language**, no high-severity conflict, score ≥ .8. Unknown language/artist/tracks caps at `probable` (human review).
- Non-Latin (e.g. Telugu) titles use a mark-preserving key. `lyrics-core.normalize()` strips combining marks and splits Telugu words (documented by a test; **not changed** here because it affects existing lyrics matching; consider a separate fix). Transliterated vs script titles are not guessed: they score low and never become `clear`.
- Different release groups within 0.05 => `ambiguous`; editions in one release group are listed, not merged. Proposals come only from the single best release, fill gaps only, and each carries `provenance`.

## 8. Live coverage run (NOT executed; needs approval)

Format: copy `backend/metadata/fixtures/live-sample.example.json`, replace every `REPLACE_ME` (the CLI refuses otherwise). Max 5 albums, albums you name or a read-only export you approve.

```
MUSICAPP_METADATA_LIVE=1 MUSICBRAINZ_USER_AGENT='MadineniMusic/0.1 (contact: <your email or URL>)' \
  node scripts/metadata-investigate.js --live --sample ./my-five-albums.json --out ./live-review
```
At most ~5 searches (>= 1.1 s apart, hard cap 50 HTTP requests). Read-only; no DB access.

Interpreting results (keep these separate):
- **Provider coverage** = for how many albums does MusicBrainz contain the release at all? A human decides this by searching musicbrainz.org and recording `groundTruth.inProviderCatalogue` *before* viewing matcher output.
- **Matcher accuracy** = among albums that are in the catalogue, did the matcher pick the right release (`expectedReleaseId`) or correctly say ambiguous/probable? Albums absent from the catalogue should come back `none`/`uncertain`; a `clear` there is a false positive.
- Five albums cannot establish catalogue-wide coverage or accuracy; they only show whether the plumbing and rules behave on real Telugu data. Any rate quoted from them is anecdote, not an estimate.
