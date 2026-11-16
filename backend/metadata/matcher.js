"use strict";
const lc = require("../lyrics-core.cjs"); // reuse existing normalisers (titleKey/albumKey/artists/known)

const LANG = { telugu: "tel", tamil: "tam", hindi: "hin", kannada: "kan", malayalam: "mal", english: "eng", marathi: "mar", bengali: "ben", punjabi: "pan" };
const WEIGHTS = { title: 0.30, artist: 0.15, tracks: 0.30, year: 0.10, language: 0.10, duration: 0.05 };
const EDITION_RX = /\b(deluxe|expanded|remaster(?:ed)?|special|anniversary|bonus|extended|edition|version|dubbing|dubbed)\b/i;

function langCode(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (LANG[s]) return LANG[s];
  return /^[a-z]{3}$/.test(s) ? s : null;
}
// lyrics-core.normalize() strips combining marks (\p{M}); in Telugu/Indic scripts that splits words and can make
// different words collide ("గీత" and "గత" both lose the vowel sign). For any non-Latin text we use a mark-preserving key.
const NON_LATIN = /[^\u0000-\u024f\u2000-\u206f]/;
function fold(v) { return String(v || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim(); }
const safe = (fn) => (v) => (NON_LATIN.test(String(v || "")) ? fold(v) : fn(v));
const albumKey = safe(lc.albumKey), titleKey = safe(lc.titleKey), norm = safe(lc.normalize);
const tokens = (s) => new Set(String(s).split(" ").filter(Boolean));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const t of a) if (b.has(t)) i += 1;
  return i / (a.size + b.size - i);
}

function scoreCandidate(local, cand) {
  const ev = {}; const conflicts = []; const flags = [];

  // title (album level)
  const lk = albumKey(local.title), ck = albumKey(cand.title);
  ev.title = lk && lk === ck ? 1 : jaccard(tokens(lk), tokens(ck));
  if (lk && lk === ck && norm(local.title) !== norm(cand.title)) flags.push("alternate_title_form");
  if (EDITION_RX.test(cand.title) || (cand.disambiguation && EDITION_RX.test(cand.disambiguation))) flags.push("edition_or_version");

  // artist
  const la = lc.known(local.artist) ? lc.artists(local.artist).map(norm) : [];
  const ca = (cand.artists || []).map(norm);
  const variousCand = ca.length === 1 && /^various artists?$/.test(ca[0]);
  if (!la.length || !ca.length || variousCand) { ev.artist = null; if (variousCand) flags.push("candidate_is_various_artists"); }
  else {
    const hit = la.filter((a) => ca.some((c) => c === a || c.includes(a) || a.includes(c))).length;
    ev.artist = hit / la.length;
    if (ev.artist < 0.5) conflicts.push({ field: "artist", existing: local.artist, candidate: cand.artists.join(", "), severity: "high" });
    else if (ev.artist < 1) flags.push("partial_artist_overlap");
  }

  // tracks
  const lt = (local.tracks || []).map((t) => titleKey(t.title)).filter(Boolean);
  const ct = (cand.tracks || []).map((t) => titleKey(t.title)).filter(Boolean);
  if (!lt.length || !ct.length) ev.tracks = null;
  else {
    const set = new Set(ct); const inter = new Set(lt.filter((t) => set.has(t))).size;
    ev.tracks = inter / Math.max(new Set(lt).size, set.size);
    if (lt.length !== ct.length) conflicts.push({ field: "trackCount", existing: lt.length, candidate: ct.length, severity: "medium" });
  }

  // year
  if (!Number.isInteger(local.year) || !Number.isInteger(cand.year)) ev.year = null;
  else {
    const d = Math.abs(local.year - cand.year);
    ev.year = d === 0 ? 1 : d === 1 ? 0.7 : d === 2 ? 0.3 : 0;
    if (d > 0) conflicts.push({ field: "year", existing: local.year, candidate: cand.year, severity: d > 1 ? "medium" : "low" });
  }

  // language
  const ll = langCode(local.language), cl = langCode(cand.language);
  if (!ll || !cl) ev.language = null;
  else {
    ev.language = ll === cl ? 1 : 0;
    if (ll !== cl) conflicts.push({ field: "language", existing: local.language, candidate: cand.language, severity: "high" });
  }

  // total duration
  const ld = (local.tracks || []).reduce((s, t) => s + (Number(t.durationSec) || 0), 0);
  const cd = (cand.tracks || []).reduce((s, t) => s + (Number(t.durationMs) || 0), 0) / 1000;
  if (!ld || !cd || (local.tracks || []).some((t) => !t.durationSec) || cand.tracks.some((t) => !t.durationMs)) ev.duration = null;
  else { const r = Math.abs(ld - cd) / Math.max(ld, cd); ev.duration = r <= 0.03 ? 1 : r <= 0.1 ? 0.5 : 0; }

  let acc = 0; const missing = [];
  for (const [k, w] of Object.entries(WEIGHTS)) { if (ev[k] === null || ev[k] === undefined) missing.push(k); else acc += w * ev[k]; }
  const score = Math.round(acc * 1000) / 1000; // missing evidence counts as zero; max 1.0 only with all six kinds present
  if (missing.includes("language")) flags.push("language_unknown");
  const evidenceKinds = Object.values(ev).filter((v) => v !== null && v !== undefined).length;
  return { score, evidence: ev, evidenceKinds, missingEvidence: missing, conflicts, flags, candidate: cand };
}

function hasHighConflict(s) { return s.conflicts.some((c) => c.severity === "high"); }

// Decide status for one local album against provider candidates. Never merges across release groups.
function matchAlbum(local, candidates) {
  const scored = candidates.map((c) => scoreCandidate(local, c)).sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: "none", reason: "provider returned no candidates", best: null, alternatives: [] };
  const best = scored[0];
  const rival = scored.slice(1).find((s) => s.candidate.releaseGroupId !== best.candidate.releaseGroupId
    && best.score - s.score <= 0.05 && s.score >= 0.5);
  const sameGroup = scored.slice(1).filter((s) => s.candidate.releaseGroupId && s.candidate.releaseGroupId === best.candidate.releaseGroupId);
  let status, reason;
  const titleOk = best.evidence.title >= 0.9;
  const e = best.evidence;
  // "clear" needs title, artist, tracks AND a known, agreeing language. Unknown language/artist/tracks caps at "probable".
  const fullEvidence = e.artist !== null && e.tracks !== null && e.language !== null;
  const trackOk = e.tracks !== null && e.tracks >= 0.7 && e.artist >= 0.9 && e.language === 1;
  if (rival) { status = "ambiguous"; reason = "two different release groups score within 0.05"; }
  else if (best.score >= 0.8 && titleOk && fullEvidence && trackOk && !hasHighConflict(best)) { status = "clear"; reason = "title, artist, tracks and a known language agree"; }
  else if (best.score >= 0.5 && titleOk && !hasHighConflict(best)) { status = "probable"; reason = `partial agreement${best.missingEvidence.length ? " (missing evidence: " + best.missingEvidence.join(", ") + ")" : ""}; human review required`; }
  else { status = "uncertain"; reason = hasHighConflict(best) ? "high-severity conflict" : "weak evidence"; }
  // recording-level links: only where the local track title key equals a candidate track title key
  const recordingLinks = [];
  for (const lt of local.tracks || []) {
    const key = titleKey(lt.title);
    const ct = best.candidate.tracks.find((t) => titleKey(t.title) === key && key);
    if (ct && ct.recordingId) recordingLinks.push({ localTitle: lt.title, candidateTitle: ct.title, recordingId: ct.recordingId });
  }
  return { status, reason, best, alternatives: scored.slice(1, 4), sameReleaseGroupEditions: sameGroup.map((s) => s.candidate.releaseId), recordingLinks };
}
module.exports = { scoreCandidate, matchAlbum, langCode, WEIGHTS };
