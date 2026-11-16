"use strict";
const lc = require("../lyrics-core.cjs");

// Review report: existing vs proposed values with sources, conflicts and evidence.
// Rules: unknown stays null; proposals are only produced for clear/probable matches; nothing is ever written.
function buildAlbumReport(local, decision, { generatedAt = new Date().toISOString(), artwork = null } = {}) {
  const b = decision.best;
  const existing = { title: local.title ?? null, artist: lc.known(local.artist) ? local.artist : null, year: local.year ?? null,
    language: local.language ?? null, trackCount: (local.tracks || []).length || null, coverPath: local.coverPath ?? null };
  const proposed = { title: null, artist: null, year: null, language: null, trackCount: null,
    externalIds: { musicbrainzReleaseId: null, musicbrainzReleaseGroupId: null, musicbrainzArtistIds: [] } };
  const fieldNotes = [];
  if (b && (decision.status === "clear" || decision.status === "probable")) {
    const c = b.candidate;
    // fill gaps only; where a value exists and differs, record a conflict instead of proposing an overwrite
    if (!existing.artist && c.artists.length && !/^various artists?$/i.test(c.artists.join(", "))) proposed.artist = c.artists.join(", ");
    if (existing.year == null && c.year != null) proposed.year = c.year;
    if (!existing.language && c.language) proposed.language = c.language;
    if (existing.trackCount == null && c.trackCount != null) proposed.trackCount = c.trackCount;
    proposed.externalIds = { musicbrainzReleaseId: c.releaseId, musicbrainzReleaseGroupId: c.releaseGroupId, musicbrainzArtistIds: c.artistIds };
    if (decision.status === "probable") fieldNotes.push("Probable match: a human must confirm before any value is applied.");
  }
  const conflicts = b ? b.conflicts.slice() : [];
  const flags = b ? b.flags.slice() : [];
  if (decision.status === "ambiguous") flags.push("ambiguous_release_group");
  if (decision.sameReleaseGroupEditions && decision.sameReleaseGroupEditions.length) flags.push("other_editions_in_same_release_group");
  return {
    kind: "album-metadata-review", version: 1, generatedAt, mode: "recommend_fixes_read_only",
    localAlbumId: local.id ?? null,
    status: decision.status, reason: decision.reason,
    confidence: b ? b.score : 0,
    evidence: b ? b.evidence : null,
    matchLevel: b ? { entity: "release", releaseId: b.candidate.releaseId, releaseGroupId: b.candidate.releaseGroupId, note: "album=local row; release=specific edition; release group=all editions; recordings linked per track" } : null,
    existing, proposed, conflicts, flags, fieldNotes,
    recordingLinks: decision.recordingLinks || [],
    alternatives: (decision.alternatives || []).map((a) => ({ releaseId: a.candidate.releaseId, releaseGroupId: a.candidate.releaseGroupId, title: a.candidate.title, language: a.candidate.language, year: a.candidate.year, score: a.score })),
    sources: b ? [{ provider: b.candidate.provider, url: b.candidate.sourceUrl, fetchedAt: b.candidate.fetchedAt, license: "MusicBrainz core data is CC0; supplementary data is CC BY-NC-SA" }] : [],
    artwork,
    untrustedExternalData: true
  };
}

function toMarkdown(reports, { title = "Album metadata review" } = {}) {
  const esc = (v) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/[|\r\n]+/g, " ").slice(0, 200));
  const L = [`# ${title}`, "", "Mode: recommend fixes (read-only). Nothing in this report has been applied. External data is untrusted; unknown values are left blank.", ""];
  for (const r of reports) {
    L.push(`## ${esc(r.existing.title)} — ${r.status.toUpperCase()} (confidence ${r.confidence})`, "", `Reason: ${esc(r.reason)}`, "");
    L.push("| Field | Existing | Proposed |", "|---|---|---|");
    for (const f of ["artist", "year", "language", "trackCount"]) L.push(`| ${f} | ${esc(r.existing[f])} | ${esc(r.proposed[f])} |`);
    L.push(`| MusicBrainz release | — | ${esc(r.proposed.externalIds.musicbrainzReleaseId)} |`, `| MusicBrainz release group | — | ${esc(r.proposed.externalIds.musicbrainzReleaseGroupId)} |`, "");
    if (r.conflicts.length) { L.push("Conflicts:"); for (const c of r.conflicts) L.push(`- [${c.severity}] ${c.field}: existing ${esc(c.existing)} vs candidate ${esc(c.candidate)}`); L.push(""); }
    if (r.flags.length) L.push(`Flags: ${r.flags.join(", ")}`, "");
    if (r.fieldNotes.length) L.push(...r.fieldNotes.map((n) => `Note: ${n}`), "");
    if (r.alternatives.length) { L.push("Alternatives considered:"); for (const a of r.alternatives) L.push(`- ${esc(a.title)} (${esc(a.language)}, ${esc(a.year)}) score ${a.score}, release ${a.releaseId}`); L.push(""); }
    for (const s of r.sources) L.push(`Source: ${s.url} (fetched ${s.fetchedAt})`, "");
  }
  return L.join("\n");
}
module.exports = { buildAlbumReport, toMarkdown };
