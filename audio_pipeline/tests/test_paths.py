"""Path configuration tests.

Third-party packages are stubbed, so these run with only the standard library:
    PYTHONPATH=. python3 -m unittest discover -s audio_pipeline/tests -v
They never touch the network, database, Google Drive or the filesystem paths.
"""

import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

STUBS = [
    "psycopg2", "psycopg2.extras", "dotenv", "openpyxl", "openpyxl.styles",
    "openpyxl.utils", "google", "google.oauth2", "google.oauth2.credentials",
    "google.auth", "google.auth.transport", "google.auth.transport.requests",
    "googleapiclient", "googleapiclient.discovery", "googleapiclient.http",
    "google_auth_oauthlib", "google_auth_oauthlib.flow",
]


class _Anything(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return mock.MagicMock(name=name)


def load(module, env):
    stubs = {name: _Anything(name) for name in STUBS if name not in sys.modules}
    with mock.patch.dict(sys.modules, stubs), mock.patch.dict(os.environ, env, clear=True):
        full = f"audio_pipeline.scripts.{module}"
        sys.modules.pop(full, None)
        return importlib.import_module(full)


MUSIC_MODULES = ["register_songs", "store_audio", "store_audio_v2", "playback_validate"]
REPORT_MODULES = ["generate_report", "upload_report", "send_email_summary"]


class PathDefaults(unittest.TestCase):
    def test_music_root_default_is_unchanged(self):
        for name in MUSIC_MODULES:
            with self.subTest(name):
                self.assertEqual(load(name, {}).MUSIC_ROOT, Path("/opt/musicapp/music/Songs").resolve())

    def test_report_dir_default_is_unchanged(self):
        for name in REPORT_MODULES:
            with self.subTest(name):
                self.assertEqual(load(name, {}).REPORT_DIR, Path("/opt/musicapp/reports"))

    def test_other_defaults_are_unchanged(self):
        self.assertEqual(load("download_incoming", {}).STAGING_DIR, Path("/opt/musicapp/staging/incoming"))
        self.assertEqual(load("db", {}).ENV_FILE, "/etc/musicapp.env")
        boot = load("google_oauth_bootstrap", {})
        self.assertEqual(boot.CLIENT_SECRET_FILE, Path("/home/rk/google_oauth.json"))
        self.assertEqual(boot.TOKEN_FILE, Path("/home/rk/google_drive_token.json"))


class PathOverrides(unittest.TestCase):
    def test_music_root_override(self):
        for name in MUSIC_MODULES:
            with self.subTest(name):
                got = load(name, {"MUSICAPP_MUSIC_ROOT": "/tmp/songs"}).MUSIC_ROOT
                self.assertEqual(got, Path("/tmp/songs").resolve())

    def test_report_dir_override(self):
        for name in REPORT_MODULES:
            with self.subTest(name):
                self.assertEqual(load(name, {"MUSICAPP_REPORT_DIR": "/tmp/r"}).REPORT_DIR, Path("/tmp/r"))

    def test_other_overrides(self):
        self.assertEqual(load("download_incoming", {"MUSICAPP_STAGING_DIR": "/tmp/s"}).STAGING_DIR, Path("/tmp/s"))
        self.assertEqual(load("db", {"MUSICAPP_DB_ENV_FILE": "/tmp/db.env"}).ENV_FILE, "/tmp/db.env")
        boot = load("google_oauth_bootstrap", {"GOOGLE_OAUTH_CLIENT_FILE": "/tmp/c.json", "GOOGLE_DRIVE_TOKEN_FILE": "/tmp/t.json"})
        self.assertEqual(boot.CLIENT_SECRET_FILE, Path("/tmp/c.json"))
        self.assertEqual(boot.TOKEN_FILE, Path("/tmp/t.json"))


if __name__ == "__main__":
    unittest.main()
