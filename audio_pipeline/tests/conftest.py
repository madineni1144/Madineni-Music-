"""Test setup: synthetic data only, no database, no network, no Drive.

Third-party packages that are not needed for the logic under test
(psycopg2, Google client) are replaced with light fakes when absent.
"""
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _fake(name, **attrs):
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except ImportError:
        pass
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


class _OperationalError(Exception):
    pass


class _InterfaceError(Exception):
    pass


_fake(
    "psycopg2",
    OperationalError=_OperationalError,
    InterfaceError=_InterfaceError,
    connect=lambda **kw: (_ for _ in ()).throw(
        _OperationalError("no database in tests")
    ),
)
_fake("google")
_fake("google.oauth2")
_fake("google.oauth2.credentials", Credentials=object)
_fake("google.auth")
_fake("google.auth.transport")
_fake("google.auth.transport.requests", Request=object)
_fake("googleapiclient")
_fake("googleapiclient.discovery", build=lambda *a, **k: None)
_fake("googleapiclient.http", MediaIoBaseDownload=object)
