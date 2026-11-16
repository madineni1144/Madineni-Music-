# Album metadata review

Mode: recommend fixes (read-only). Nothing in this report has been applied. External data is untrusted; unknown values are left blank.

## Fixture Sparse Album (Original Motion Picture Soundtrack) — PROBABLE (confidence 0.75)

Reason: partial agreement (missing evidence: artist, year); human review required

| Field | Existing | Proposed |
|---|---|---|
| artist | — | Fixture Composer |
| year | — | 2018 |
| language | Telugu | — |
| trackCount | 4 | — |
| MusicBrainz release | — | 00000000-0000-4000-8000-000000000101 |
| MusicBrainz release group | — | 00000000-0000-4000-8000-000000000001 |

Flags: alternate_title_form

Note: Probable match: a human must confirm before any value is applied.

Alternatives considered:
- Unrelated Thing (eng, 2010) score 0, release 00000000-0000-4000-8000-000000000102

Source: https://musicbrainz.org/release/00000000-0000-4000-8000-000000000101 (fetched 2026-01-01T00:00:00.000Z)

## Fixture Ambiguous Film — AMBIGUOUS (confidence 0.9)

Reason: two different release groups score within 0.05

| Field | Existing | Proposed |
|---|---|---|
| artist | Fixture Composer | — |
| year | 2020 | — |
| language | — | — |
| trackCount | 3 | — |
| MusicBrainz release | — | — |
| MusicBrainz release group | — | — |

Flags: language_unknown, ambiguous_release_group

Alternatives considered:
- Fixture Ambiguous Film (tam, 2020) score 0.9, release 00000000-0000-4000-8000-000000000202

Source: https://musicbrainz.org/release/00000000-0000-4000-8000-000000000201 (fetched 2026-01-01T00:00:00.000Z)

## Fixture Missing Album — NONE (confidence 0)

Reason: provider returned no candidates

| Field | Existing | Proposed |
|---|---|---|
| artist | Nobody | — |
| year | 2001 | — |
| language | Telugu | — |
| trackCount | 1 | — |
| MusicBrainz release | — | — |
| MusicBrainz release group | — | — |

## Fixture Edition Album — CLEAR (confidence 1)

Reason: title, artist, tracks and a known language agree

| Field | Existing | Proposed |
|---|---|---|
| artist | Edition Artist | — |
| year | 2018 | — |
| language | English | — |
| trackCount | 5 | — |
| MusicBrainz release | — | 00000000-0000-4000-8000-000000000301 |
| MusicBrainz release group | — | 00000000-0000-4000-8000-000000000021 |

Flags: edition_or_version, other_editions_in_same_release_group

Alternatives considered:
- Fixture Edition Album (Deluxe Edition) (eng, 2019) score 0.795, release 00000000-0000-4000-8000-000000000302

Source: https://musicbrainz.org/release/00000000-0000-4000-8000-000000000301 (fetched 2026-01-01T00:00:00.000Z)
