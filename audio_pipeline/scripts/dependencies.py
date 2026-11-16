"""Pre-flight checks for external executables."""

import shutil

from audio_pipeline.scripts.errors import MissingDependencyError


def require_executables(names=("ffprobe", "ffmpeg"), which=shutil.which):
    """Raise MissingDependencyError before any item is touched.

    A missing executable halts the run (SYSTEM_ERROR). It must never be
    confused with a missing audio file and never marks songs failed.
    """
    missing = [name for name in names if which(name) is None]

    if missing:
        raise MissingDependencyError(
            "Required executable(s) not found on PATH: "
            + ", ".join(missing)
            + ". Run halted; no songs were changed."
        )
