#!/usr/bin/env node
"use strict";
// Album metadata investigation (READ-ONLY, recommend-fixes). Default: five synthetic fixture albums, no network.
// Live mode needs an explicit sample file (<=5 albums) AND MUSICAPP_METADATA_LIVE=1. It never scans the catalogue
// and never writes to the database; output is a JSON + markdown review report.
const fs = require("node:fs");
const path = require("node:path");
const { createMusicBrainz } = require("../backend/metadata/musicbrainz");
const { createArtworkMock } = require("../backend/metadata/artwork-mock");
const { createInvestigationTools } = require("../backend/metadata/agent-tools");
const fx = require("../backend/metadata/fixtures");

async function main(argv, env, out = console) {
  const args = { sample: null, outDir: "metadata-review-output", live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sample") args.sample = argv[++i];
    else if (argv[i] === "--out") args.outDir = argv[++i];
    else if (argv[i] === "--live") args.live = true;
    else { out.error(`unknown argument: ${argv[i]}`); return 2; }
  }
  let albums, provider, now = () => Date.now();
  if (args.live) {
    if (env.MUSICAPP_METADATA_LIVE !== "1") { out.error("live mode disabled: set MUSICAPP_METADATA_LIVE=1 (needs separate approval)"); return 3; }
    if (!args.sample) { out.error("live mode requires --sample <file> with at most 5 albums; no full-catalogue scans"); return 2; }
    if (!env.MUSICBRAINZ_USER_AGENT) { out.error("MUSICBRAINZ_USER_AGENT is required (e.g. 'AppName/1.0 (contact)')"); return 3; }
    albums = JSON.parse(fs.readFileSync(args.sample, "utf8"));
    provider = createMusicBrainz({ userAgent: env.MUSICBRAINZ_USER_AGENT });
  } else {
    albums = args.sample ? JSON.parse(fs.readFileSync(args.sample, "utf8")) : fx.localAlbums;
    now = () => Date.parse("2026-01-01T00:00:00Z"); // fixed clock => byte-reproducible output
    provider = createMusicBrainz({ userAgent: "MadineniMusic-fixtures/0 (offline)", minIntervalMs: 0, now,
      httpOptions: { fetch: fx.makeFakeFetch(), sleep: async () => {}, maxRetries: 1, backoffMs: 0, isolate: true } });
  }
  if (!Array.isArray(albums) || albums.length === 0 || albums.length > 5) { out.error("sample must contain 1-5 albums"); return 2; }
  if (albums.some((a) => /REPLACE_ME/.test(JSON.stringify(a)))) { out.error("sample still contains REPLACE_ME placeholders"); return 2; }
  const auditPath = path.join(args.outDir, "audit.jsonl");
  fs.mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
  fs.rmSync(auditPath, { force: true });
  const tools = createInvestigationTools({ provider, artwork: createArtworkMock({}), auditPath, now });
  for (const album of albums) {
    const r = await tools.call("investigate_album", { album });
    out.log(`${album.title}: ${r.ok ? r.result.status : "ERROR " + r.error.code}`);
  }
  const rep = await tools.call("generate_report", {});
  fs.writeFileSync(path.join(args.outDir, "report.json"), JSON.stringify({ reports: rep.result.json, failures: tools.auditLog().filter((e) => !e.ok) }, null, 2));
  fs.writeFileSync(path.join(args.outDir, "report.md"), rep.result.markdown);
  out.log(`wrote ${args.outDir}/report.json, report.md, audit.jsonl`);
  return 0;
}
if (require.main === module) main(process.argv.slice(2), process.env).then((c) => process.exit(c));
module.exports = { main };
