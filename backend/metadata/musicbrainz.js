"use strict";
const { ProviderError } = require("./errors");
const { createHttpProvider } = require("./http-provider");

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v) => (typeof v === "string" ? v : "");

function luceneQuote(v) { return `"${String(v).replace(/(["\\])/g, "\\$1").slice(0, 200)}"`; }
function yearOf(date) { const m = /^(\d{4})/.exec(str(date)); return m ? Number(m[1]) : null; }

// Normalise one MusicBrainz release into the internal candidate shape. Unknowns stay null/empty.
function normalizeRelease(r, fetchedAt) {
  if (!r || typeof r !== "object" || !MBID.test(str(r.id)) || !str(r.title)) {
    throw new ProviderError("malformed", "musicbrainz: release missing id/title", { provider: "musicbrainz" });
  }
  const credit = Array.isArray(r["artist-credit"]) ? r["artist-credit"] : [];
  const tracks = [];
  for (const medium of Array.isArray(r.media) ? r.media : []) {
    for (const t of Array.isArray(medium.tracks) ? medium.tracks : []) {
      tracks.push({
        position: Number.isInteger(t.position) ? t.position : null,
        disc: Number.isInteger(medium.position) ? medium.position : null,
        title: str(t.title),
        durationMs: Number.isFinite(t.length) ? t.length : null,
        recordingId: t.recording && MBID.test(str(t.recording.id)) ? t.recording.id : null
      });
    }
  }
  const rg = r["release-group"] && typeof r["release-group"] === "object" ? r["release-group"] : {};
  const tr = r["text-representation"] && typeof r["text-representation"] === "object" ? r["text-representation"] : {};
  return {
    provider: "musicbrainz",
    entity: "release",
    releaseId: r.id,
    releaseGroupId: MBID.test(str(rg.id)) ? rg.id : null,
    releaseGroupType: str(rg["primary-type"]) || null,
    title: r.title,
    disambiguation: str(r.disambiguation) || null,
    artists: credit.map((c) => str(c.name || (c.artist && c.artist.name))).filter(Boolean),
    artistIds: credit.map((c) => c.artist && MBID.test(str(c.artist.id)) ? c.artist.id : null).filter(Boolean),
    date: str(r.date) || null,
    year: yearOf(r.date),
    country: str(r.country) || null,
    status: str(r.status) || null,
    language: str(tr.language) || null, // ISO 639-3 as published, e.g. "tel"
    script: str(tr.script) || null,
    trackCount: tracks.length || (Number.isInteger(r["track-count"]) ? r["track-count"] : null),
    tracks,
    searchScore: Number.isFinite(r.score) ? r.score : null,
    sourceUrl: `https://musicbrainz.org/release/${r.id}`,
    fetchedAt
  };
}

function createMusicBrainz(options = {}) {
  const now = options.now || (() => Date.now());
  const http = options.http || createHttpProvider({
    name: "musicbrainz", baseUrl: options.baseUrl || "https://musicbrainz.org/ws/2/",
    userAgent: options.userAgent, minIntervalMs: options.minIntervalMs ?? 1100, maxRequests: options.maxRequests ?? 50, ...options.httpOptions
  });
  return {
    name: "musicbrainz",
    stats: http.stats,
    async searchReleases({ title, artist, limit = 10 }) {
      if (!str(title).trim()) throw new ProviderError("config", "musicbrainz: title is required", { provider: "musicbrainz" });
      let q = `release:${luceneQuote(title)}`;
      if (str(artist).trim()) q += ` AND artist:${luceneQuote(artist)}`;
      const body = await http.getJson("release", { query: q, fmt: "json", limit: Math.min(Math.max(limit, 1), 25) });
      if (!body || typeof body !== "object" || !Array.isArray(body.releases)) {
        throw new ProviderError("malformed", "musicbrainz: search response has no releases array", { provider: "musicbrainz" });
      }
      const fetchedAt = new Date(now()).toISOString();
      const out = [];
      for (const r of body.releases) { try { out.push(normalizeRelease(r, fetchedAt)); } catch { /* drop malformed rows, keep good ones */ } }
      if (body.releases.length && !out.length) throw new ProviderError("malformed", "musicbrainz: no usable releases", { provider: "musicbrainz" });
      return out;
    },
    async lookupRelease(mbid) {
      if (!MBID.test(str(mbid))) throw new ProviderError("config", "musicbrainz: invalid MBID", { provider: "musicbrainz" });
      const body = await http.getJson(`release/${mbid}`, { inc: "recordings+artist-credits+release-groups+labels", fmt: "json" });
      return normalizeRelease(body, new Date(now()).toISOString());
    }
  };
}
module.exports = { createMusicBrainz, normalizeRelease, MBID };
