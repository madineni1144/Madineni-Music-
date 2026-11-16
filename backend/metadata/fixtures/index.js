"use strict";
// SYNTHETIC fixtures: invented albums and fake MBIDs shaped like MusicBrainz responses. Not real catalogue data.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const trackList = (names, lens) => names.map((t, i) => ({ position: i + 1, title: t, length: lens ? lens[i] : 240000, recording: { id: id(9000 + i) } }));
const release = ({ n, rg, title, artist, artistN, date, lang, names, extra = {} }) => ({
  id: id(n), title, score: 100, date, country: "IN", status: "Official",
  "artist-credit": [{ name: artist, artist: { id: id(artistN), name: artist } }],
  "release-group": { id: id(rg), "primary-type": "Album" },
  "text-representation": { language: lang, script: "Latn" },
  media: [{ position: 1, tracks: trackList(names) }], ...extra
});
const T1 = ["Alpha Song", "Beta Song", "Gamma Song", "Delta Song"];
const T2 = ["Ek", "Do", "Teen"];
const T3 = ["One", "Two", "Three", "Four", "Five"];

const localAlbums = [
  { id: "fx-1", title: "Fixture Sparse Album (Original Motion Picture Soundtrack)", artist: null, year: null, language: "Telugu", tracks: T1.map((t) => ({ title: t, durationSec: 240 })) },
  { id: "fx-2", title: "Fixture Ambiguous Film", artist: "Fixture Composer", year: 2020, language: null, tracks: T2.map((t) => ({ title: t, durationSec: 240 })) },
  { id: "fx-3", title: "Fixture Missing Album", artist: "Nobody", year: 2001, language: "Telugu", tracks: [{ title: "Lost", durationSec: 200 }] },
  { id: "fx-4", title: "Fixture Malformed Album", artist: "Someone", year: 2015, language: null, tracks: [{ title: "X", durationSec: 100 }] },
  { id: "fx-5", title: "Fixture Edition Album", artist: "Edition Artist", year: 2018, language: "English", tracks: T3.map((t) => ({ title: t, durationSec: 240 })) }
];

const responses = {
  "Fixture Sparse Album (Original Motion Picture Soundtrack)": { releases: [
    release({ n: 101, rg: 1, title: "Fixture Sparse Album", artist: "Fixture Composer", artistN: 501, date: "2018-08-01", lang: "tel", names: T1 }),
    release({ n: 102, rg: 2, title: "Unrelated Thing", artist: "Other", artistN: 502, date: "2010", lang: "eng", names: ["Q", "R"] })] },
  "Fixture Ambiguous Film": { releases: [
    release({ n: 201, rg: 11, title: "Fixture Ambiguous Film", artist: "Fixture Composer", artistN: 503, date: "2020-01-01", lang: "tel", names: T2 }),
    release({ n: 202, rg: 12, title: "Fixture Ambiguous Film", artist: "Fixture Composer", artistN: 503, date: "2020-01-05", lang: "tam", names: T2 })] },
  "Fixture Missing Album": { releases: [] },
  "Fixture Malformed Album": { releases: "not-an-array" },
  "Fixture Edition Album": { releases: [
    release({ n: 301, rg: 21, title: "Fixture Edition Album", artist: "Edition Artist", artistN: 504, date: "2018-05-01", lang: "eng", names: T3 }),
    release({ n: 302, rg: 21, title: "Fixture Edition Album (Deluxe Edition)", artist: "Edition Artist", artistN: 504, date: "2019-05-01", lang: "eng", names: [...T3, "Bonus"] })] }
};

// Fake fetch keyed by the `release:"..."` part of the query. `faults` can inject statuses/throws per title.
function makeFakeFetch({ faults = {}, log = [] } = {}) {
  return async (url) => {
    const u = new URL(url); log.push(u.pathname + u.search);
    const q = u.searchParams.get("query") || "";
    const m = /release:"((?:[^"\\]|\\.)*)"/.exec(q);
    const title = m ? m[1].replace(/\\(.)/g, "$1") : "";
    const fault = faults[title];
    if (fault && fault.throws) { const e = new Error("net"); e.name = fault.throws; throw e; }
    if (fault && fault.status) return { status: fault.status, headers: { get: () => fault.retryAfter ?? null }, text: async () => "" };
    const body = responses[title];
    if (body === undefined) return { status: 404, headers: { get: () => null }, text: async () => "" };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}
module.exports = { localAlbums, responses, makeFakeFetch, id };
