"""AI lyrics draft tests. Standard library only; no Whisper, database, network or real audio.
    PYTHONPATH=. python3 -m unittest discover -s audio_pipeline/tests -v
"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "ai_lyrics", Path(__file__).resolve().parents[1] / "scripts" / "ai_lyrics.py")
ai = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ai)


def seg(text, start=0.0, end=1.0, lp=-0.2, nsp=0.0):
    return {"text": text, "start": start, "end": end, "avg_logprob": lp, "no_speech_prob": nsp}


class Formatting(unittest.TestCase):
    def test_timestamp_and_lrc(self):
        self.assertEqual(ai.format_timestamp(0), "00:00.00")
        self.assertEqual(ai.format_timestamp(75.5), "01:15.50")
        self.assertEqual(ai.to_lrc([{"start": 5.25, "text": "hello"}]), "[00:05.25]hello")

    def test_negative_time_is_clamped(self):
        self.assertEqual(ai.format_timestamp(-3), "00:00.00")


class Cleaning(unittest.TestCase):
    def test_drops_empty_silent_and_low_confidence(self):
        out = ai.clean_segments([seg("  "), seg("noise", nsp=0.9), seg("mumble", lp=-5), seg("la la", lp=-0.1)])
        self.assertEqual([s["text"] for s in out], ["la la"])

    def test_drops_looping_hallucination(self):
        out = ai.clean_segments([seg("same line", start=i) for i in range(10)])
        self.assertEqual(len(out), ai.MAX_REPEATS)

    def test_confidence_bounds(self):
        self.assertEqual(ai.confidence_from_logprob(0), 1.0)
        self.assertEqual(ai.confidence_from_logprob("bad"), 0.0)
        self.assertEqual(ai.overall_confidence([]), 0.0)


class Classification(unittest.TestCase):
    def test_instrumental_when_little_singing(self):
        self.assertEqual(ai.build_draft({"segments": [seg("ooh")], "language": "te"})["status"], "instrumental")
        self.assertEqual(ai.build_draft({"segments": []})["status"], "instrumental")

    def test_draft_has_text_and_lrc(self):
        d = ai.build_draft({"language": "te", "segments": [
            seg("one two three four", 1, 3), seg("five six seven eight nine", 3, 6)]})
        self.assertEqual(d["status"], "draft")
        self.assertEqual(d["language"], "te")
        self.assertTrue(d["synced_lrc"].startswith("[00:01.00]one two"))
        self.assertEqual(d["plain_text"].count("\n"), 1)

    def test_instrumental_stores_no_text(self):
        d = ai.build_draft({"segments": []})
        self.assertIsNone(d["plain_text"])
        self.assertIsNone(d["synced_lrc"])


class Paths(unittest.TestCase):
    def test_stays_inside_music_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            (Path(root) / "a.mp3").write_bytes(b"x")
            (Path(other) / "b.mp3").write_bytes(b"x")
            self.assertEqual(ai.resolve_audio_path("/music/a.mp3", root), (Path(root) / "a.mp3").resolve())
            self.assertIsNone(ai.resolve_audio_path(str(Path(other) / "b.mp3"), root))
            self.assertIsNone(ai.resolve_audio_path("../b.mp3", root))
            self.assertIsNone(ai.resolve_audio_path("", root))
            self.assertIsNone(ai.resolve_audio_path("missing.mp3", root))


class Safety(unittest.TestCase):
    def test_candidate_query_is_read_only_on_existing_tables(self):
        sql = ai.CANDIDATES_SQL.upper()
        for word in ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER"):
            self.assertNotIn(word, sql)
        self.assertIn("'NOT_FOUND'", sql)

    def test_limit_is_capped(self):
        self.assertLessEqual(ai.MAX_LIMIT, 50)

    def test_schema_never_touches_existing_tables(self):
        import re
        text = ai.SCHEMA_FILE.read_text()
        self.assertIsNone(re.search(r"^\s*(ALTER|DROP|UPDATE|DELETE|INSERT|TRUNCATE)\b", text, re.I | re.M))
        created = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", text)
        self.assertEqual(created, ["madineni_ai_lyrics", "madineni_ai_lyrics_feedback"])

    def test_writes_need_apply_flag(self):
        # Without --apply, review and schema commands only print and never connect.
        ai._connect = lambda: (_ for _ in ()).throw(AssertionError("connected without --apply"))
        for argv in (["approve", "--id", "1"], ["reject", "--id", "1"], ["init-schema"]):
            ai.main(argv)


if __name__ == "__main__":
    unittest.main()
