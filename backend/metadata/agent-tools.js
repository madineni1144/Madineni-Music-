"use strict";
const fs = require("node:fs");
const { ProviderError } = require("./errors");
const { matchAlbum, scoreCandidate } = require("./matcher");
const { buildAlbumReport, toMarkdown } = require("./report");

const MAX_STR = 300;
// External content is untrusted: strip control chars, cap length, and never interpret it as instructions.
function sanitize(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === "string") return v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").slice(0, MAX_STR);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 60)) o[String(k).slice(0, 60)] = sanitize(x, depth + 1); return o; }
  return v;
}

function validateAlbum(a) {
  if (!a || typeof a !== "object") throw new ProviderError("config", "album must be an object");
  const s = (v, n) => typeof v === "string" && v.trim() && v.length <= n;
  if (!s(a.title, 200)) throw new ProviderError("config", "album.title required (<=200 chars)");
  if (a.artist != null && !(typeof a.artist === "string" && a.artist.length <= 200)) throw new ProviderError("config", "album.artist invalid");
  if (a.year != null && !(Number.isInteger(a.year) && a.year >= 1900 && a.year <= 2100)) throw new ProviderError("config", "album.year invalid");
  if (a.tracks != null && !(Array.isArray(a.tracks) && a.tracks.length <= 100 && a.tracks.every((t) => t && s(t.title, 200)))) throw new ProviderError("config", "album.tracks invalid");
  return { id: a.id ?? null, title: a.title, artist: a.artist ?? null, year: a.year ?? null, language: a.language ?? null,
    coverPath: a.coverPath ?? null, tracks: (a.tracks || []).map((t) => ({ title: t.title, durationSec: Number(t.durationSec) || null })) };
}

// Narrow, READ-ONLY tool set. There is no write tool: the agent can only recommend. Lyrics are never generated here.
function createInvestigationTools({ provider, artwork = null, limits = {}, auditPath = null, now = () => Date.now() }) {
  const lim = { maxProviderCalls: 20, maxAlbums: 5, ...limits };
  const audit = [];
  const state = { providerCalls: 0, albums: 0, decisions: new Map() };
  const rec = (e) => { const row = { ts: new Date(now()).toISOString(), ...e }; audit.push(row);
    if (auditPath) { try { fs.appendFileSync(auditPath, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* audit file is best effort */ } } };

  const tools = {
    investigate_album: {
      description: "Search MusicBrainz for one local album and classify the match (clear/probable/ambiguous/uncertain/none). Read-only.",
      inputSchema: { type: "object", required: ["album"], properties: { album: { type: "object" } } },
      async handler({ album }) {
        const local = validateAlbum(album);
        if (state.albums >= lim.maxAlbums) throw new ProviderError("budget", `album limit reached (${lim.maxAlbums}); full-catalogue scans are not allowed`);
        if (state.providerCalls >= lim.maxProviderCalls) throw new ProviderError("budget", "provider call budget exhausted");
        state.albums += 1; state.providerCalls += 1;
        const cands = await provider.searchReleases({ title: local.title, artist: local.artist });
        const decision = matchAlbum(local, cands);
        let art = null;
        if (artwork && decision.best) art = await artwork.check(decision.best.candidate.releaseId);
        const report = sanitize(buildAlbumReport(local, decision, { generatedAt: new Date(now()).toISOString(), artwork: art }));
        state.decisions.set(local.id ?? local.title, report);
        return { status: report.status, confidence: report.confidence, reportKey: local.id ?? local.title };
      }
    },
    compare_metadata: {
      description: "Deterministically score one candidate release against local album metadata. No network calls.",
      inputSchema: { type: "object", required: ["album", "candidate"], properties: { album: { type: "object" }, candidate: { type: "object" } } },
      async handler({ album, candidate }) {
        const local = validateAlbum(album);
        if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.tracks) || !Array.isArray(candidate.artists)) throw new ProviderError("config", "candidate must be a normalised release");
        const s = scoreCandidate(local, sanitize(candidate));
        return { score: s.score, evidence: s.evidence, conflicts: s.conflicts, flags: s.flags };
      }
    },
    generate_report: {
      description: "Render the review report (JSON + markdown) for albums investigated in this session. Read-only; applies nothing.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const reports = [...state.decisions.values()];
        return { json: reports, markdown: toMarkdown(reports) };
      }
    }
  };

  return {
    mode: "recommend_fixes",
    manifest() { return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, readOnly: true })); },
    auditLog() { return audit.slice(); },
    usage() { return { providerCalls: state.providerCalls, albums: state.albums, httpRequests: provider.stats ? provider.stats.requests : null, limits: lim }; },
    async call(name, args) {
      const t0 = now();
      if (!Object.prototype.hasOwnProperty.call(tools, name)) { rec({ tool: name, ok: false, error: "unknown_tool" }); return { ok: false, error: { code: "unknown_tool", message: `unknown tool '${String(name).slice(0, 60)}'` } }; }
      try {
        const result = await tools[name].handler(args || {});
        rec({ tool: name, ok: true, input: { title: args && args.album && args.album.title }, ms: now() - t0, result: { status: result.status } });
        return { ok: true, result };
      } catch (e) {
        const code = e instanceof ProviderError ? e.code : "internal_error";
        rec({ tool: name, ok: false, error: code, input: { title: args && args.album && args.album.title }, ms: now() - t0 });
        return { ok: false, error: { code, message: e instanceof ProviderError ? e.message : "internal error" } };
      }
    }
  };
}
module.exports = { createInvestigationTools, sanitize, validateAlbum };
