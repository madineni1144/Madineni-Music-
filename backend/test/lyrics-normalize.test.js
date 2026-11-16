"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lyrics-core.cjs");

// Frozen copy of the previous normalize(), used only to prove Latin behaviour did not change.
function oldNormalize(value) {
  return core.clean(value).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

// Real Telugu text (film/song titles, artist names). Escapes in comments are for reviewers without Telugu fonts.
const T = {
  geethaGovindam: "గీత గోవిందం",                  // album, "Geetha Govindam"
  inkem: "ఇంకేం ఇంకేం కావాలే",                    // song
  samajavaragamana: "సామజవరగమన",                  // song
  srimanthudu: "శ్రీమంతుడు",                       // conjunct with virama
  sidSriram: "సిద్ శ్రీరామ్",                       // artist, virama at word end
  rangasthalam: "రంగస్థలం"
};

test("Telugu: words and vowel signs survive normalisation (previously split into single letters)", () => {
  assert.equal(core.normalize(T.srimanthudu), "శ్రీమంతుడు");
  assert.equal(core.normalize(T.geethaGovindam), "గీత గోవిందం");
  assert.equal(core.normalize(T.inkem), "ఇంకేం ఇంకేం కావాలే");
  assert.equal(core.normalize(T.sidSriram), "సిద్ శ్రీరామ్");
  assert.equal(core.normalize(T.rangasthalam), "రంగస్థలం");
  assert.equal(oldNormalize(T.srimanthudu), "శ ర మ త డ", "documents the old fragmenting behaviour");
});

test("Telugu: words that differ only by a vowel sign no longer collide", () => {
  for (const [a, b] of [["గీత", "గిత"], ["కి", "కు"], ["కాలం", "కలం"], ["గీత", "గూత"]]) {
    assert.equal(oldNormalize(a) === oldNormalize(b) || a === "కాలం", true, `old: ${a}/${b} (kaalam/kalam differed already)`);
    assert.notEqual(core.normalize(a), core.normalize(b), `${a} vs ${b}`);
  }
  assert.equal(oldNormalize("కి"), oldNormalize("కు"), "old behaviour collided these");
});

test("Telugu: ZWNJ/ZWJ inside a word do not create a word boundary; punctuation and spaces still do", () => {
  assert.equal(core.normalize("శ్రీ‌మంతుడు"), "శ్రీమంతుడు");
  assert.equal(core.normalize("శ్రీ‍మంతుడు"), "శ్రీమంతుడు");
  assert.equal(core.normalize("గీత-గోవిందం"), "గీత గోవిందం");
  assert.equal(core.normalize("గీత​గోవిందం"), "గీత గోవిందం", "zero-width SPACE is a boundary");
  assert.equal(core.normalize("గీత గోవిందం (2018)"), "గీత గోవిందం 2018");
  assert.equal(core.normalize("౨౦౧౮"), "౨౦౧౮", "Telugu digits are kept");
});

test("Telugu titleKey/albumKey/artists keep marks and still strip Latin edition markers", () => {
  assert.equal(core.titleKey("సామజవరగమన (From \"Ala Vaikunthapurramuloo\")"), "సామజవరగమన");
  assert.equal(core.albumKey("గీత గోవిందం (Original Motion Picture Soundtrack)"), "గీత గోవిందం");
  assert.ok(core.artists("సిద్ శ్రీరామ్, Sid Sriram").includes("సిద్ శ్రీరామ్"));
  assert.equal(core.known("సిద్ శ్రీరామ్"), true);
});

test("matchScore: same Telugu title matches; a title differing only by vowel sign no longer does", () => {
  const song = { title: "కి", artist: "సిద్ శ్రీరామ్", album: "గీత గోవిందం", duration_seconds: 200 };
  const rec = (name) => ({ trackName: name, artistName: "సిద్ శ్రీరామ్", albumName: "గీత గోవిందం", plainLyrics: "x", duration: 200 });
  assert.ok(core.matchScore(song, rec("కి")) >= 0);
  assert.equal(core.matchScore(song, rec("కు")), -1, "was a false positive when marks were dropped");
  const real = { title: T.inkem, artist: T.sidSriram, album: T.geethaGovindam, duration_seconds: 223 };
  assert.ok(core.matchScore(real, { trackName: T.inkem, artistName: T.sidSriram, albumName: T.geethaGovindam, plainLyrics: "x", duration: 223 }) >= 0);
});

test("Latin and other non-mark text: normalize/titleKey/albumKey/artists are identical to the previous implementation", () => {
  const corpus = [
    "Inkem Inkem Kaavaale", "Samajavaragamana (From \"Ala Vaikunthapurramuloo\")", "Café del Mar", "Beyoncé feat. Jay-Z", "Dhoom Machale [Remastered]",
    "A.R. Rahman & Sid Sriram", "  01 - Track.mp3 ", "Title (Deluxe) ", "Rock'n'Roll – 2019 Edition", "ÀÉÎÕÜ ñ ß", "x́ y", "é", "Ǆ ǅ", "１２３ ＡＢＣ", "", "!!!", "Σίσυφος", "Привет, мир", "日本語のタイトル", "한국어 제목"
  ];
  for (const s of corpus) {
    const pre = oldNormalize(s);
    const now = core.normalize(s);
    if (/\p{M}/u.test(s.normalize("NFKC"))) continue; // inputs that still contain marks after NFKC are covered by the Telugu tests
    assert.equal(now, pre, JSON.stringify(s));
  }
  // deterministic fuzz over Latin-1/Latin Extended-A + punctuation (no combining marks after NFKC)
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const alphabet = "abcXYZ019 -_.,()[]'&éèüñßÀ–—:;!?/\\";
  for (let i = 0; i < 4000; i++) {
    let s = ""; const n = 1 + Math.floor(rnd() * 24); for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.equal(core.normalize(s), oldNormalize(s), JSON.stringify(s));
  }
});

test("cache identity: fingerprint() does not depend on normalize(); golden hashes recorded BEFORE the change still hold", () => {
  const songs = [
    { title: "Inkem Inkem Kaavaale", artist: "Sid Sriram", album: "Geetha Govindam", duration_seconds: 223, file_path: "a.mp3|v1" },
    { title: T.inkem, artist: T.sidSriram, album: T.geethaGovindam, duration_seconds: 223, file_path: "b.mp3|v1" },
    { title: T.samajavaragamana, artist: "Sid Sriram", album: "Ala Vaikunthapurramuloo", duration_seconds: 226, file_path: "c.mp3|v1" }
  ];
  assert.deepEqual(songs.map(core.fingerprint), [
    "9f89ed9e2fa5bd75cff7d1e4b3edffb57e0225ba3213d6c668ed82532f1df148",
    "6522c5e5545529ed23098845e6f822f242a1084ca368603459797adbe1f6b6d8",
    "1285b5727bcbffc3427d4d320806e7e48e88a09439a65d3f03a2b280b3478e16"
  ]);
});
