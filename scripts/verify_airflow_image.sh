#!/usr/bin/env bash
# Verify that an Airflow image built from airflow/Dockerfile can import everything
# the audio pipeline needs. Safe by construction:
#   * refuses the production tag; build under a separate tag, e.g.
#       docker build -t music-airflow:3.1.0-test airflow/
#   * --network none: no Google Drive, Gmail, database or internet access
#   * --entrypoint python: Airflow's entrypoint, scheduler and DAG parsing never start
#   * no env files, no token files, no data volumes; repo mounted read-only
# Usage: scripts/verify_airflow_image.sh music-airflow:3.1.0-test
set -euo pipefail

IMAGE="${1:?usage: $0 <image:test-tag>}"
if [ "$IMAGE" = "music-airflow:3.1.0" ]; then
  echo "Refusing to run against the production tag. Build a separate test tag." >&2
  exit 2
fi
command -v docker >/dev/null || { echo "BLOCKED: docker CLI not found" >&2; exit 3; }
docker info >/dev/null 2>&1 || { echo "BLOCKED: docker daemon not reachable" >&2; exit 3; }
docker image inspect "$IMAGE" >/dev/null

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "== third-party imports used by audio_pipeline/scripts =="
docker run --rm -i --network none --entrypoint python "$IMAGE" -I - <<'PY'
import importlib, importlib.metadata as md, sys
required = {
    "googleapiclient.discovery": "google-api-python-client",
    "googleapiclient.http": "google-api-python-client",
    "google.oauth2.credentials": "google-auth",
    "google.auth.transport.requests": "google-auth",
    "google_auth_oauthlib.flow": "google-auth-oauthlib",
    "psycopg2": "psycopg2-binary",
    "dotenv": "python-dotenv",
    "openpyxl": "openpyxl",
    "openpyxl.styles": "openpyxl",
    "openpyxl.utils": "openpyxl",
    "mutagen": "mutagen",
    "PIL": "pillow",
}
failed = []
for module, dist in sorted(required.items()):
    try:
        importlib.import_module(module)
        print(f"ok   {module:36} {dist}=={md.version(dist)}")
    except Exception as exc:
        failed.append(module)
        print(f"FAIL {module:36} {type(exc).__name__}: {exc}")
sys.exit(1 if failed else 0)
PY

echo "== dependency consistency (pip check) =="
docker run --rm --network none --entrypoint python "$IMAGE" -I -m pip check

echo "== ffprobe / ffmpeg present =="
docker run --rm --network none --entrypoint ffprobe "$IMAGE" -version | head -1
docker run --rm --network none --entrypoint ffmpeg  "$IMAGE" -version | head -1

echo "== every pipeline script imports cleanly (no main(), no connections) =="
# NOTE: python -I (isolated mode) ignores PYTHONPATH, so passing -e PYTHONPATH=/src made every import fail with
# "No module named 'audio_pipeline'" even though the image was fine. Put the mounted repo on sys.path explicitly.
docker run --rm -i --network none -v "$REPO":/src:ro --entrypoint python "$IMAGE" -B -I - <<'PY'
import importlib, pathlib, sys
sys.path.insert(0, "/src")
failed = []
paths = sorted(pathlib.Path("/src/audio_pipeline/scripts").glob("*.py"))
if not paths:
    print("FAIL no pipeline scripts found under /src/audio_pipeline/scripts"); sys.exit(1)
for path in paths:
    name = f"audio_pipeline.scripts.{path.stem}"
    try:
        importlib.import_module(name)
        print("ok  ", name)
    except Exception as exc:
        failed.append(name)
        print("FAIL", name, f"{type(exc).__name__}: {exc}")
sys.exit(1 if failed else 0)
PY

echo "== DAG loads with no import errors (DagBag only; scheduler/webserver never start) =="
docker run --rm -i --network none -v "$REPO":/src:ro -e AIRFLOW__CORE__LOAD_EXAMPLES=False \
  --entrypoint python "$IMAGE" -B -I - <<'PY'
import sys
sys.path.insert(0, "/src")
try:
    from airflow.dag_processing.dagbag import DagBag
except ImportError:
    from airflow.models.dagbag import DagBag
bag = DagBag(dag_folder="/src/airflow/dags", include_examples=False)
if bag.import_errors:
    for path, err in bag.import_errors.items():
        print("IMPORT ERROR", path, str(err).splitlines()[-1] if str(err) else "")
    sys.exit(1)
ids = sorted(bag.dags)
print("dags:", ids)
if "madineni_audio_pipeline" not in ids:
    print("FAIL expected DAG madineni_audio_pipeline not loaded"); sys.exit(1)
dag = bag.dags["madineni_audio_pipeline"]
print("tasks:", sorted(t.task_id for t in dag.tasks))
sys.exit(0 if dag.tasks else 1)
PY
echo "ALL CHECKS PASSED for $IMAGE"
