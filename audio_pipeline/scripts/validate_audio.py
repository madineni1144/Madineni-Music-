from pathlib import Path
import argparse
import json
import subprocess

from audio_pipeline.scripts.db import (
    claim_due_retries,
    get_pending_import_items,
    get_import_job,
    record_item_error,
    update_import_item_validation,
)
from audio_pipeline.scripts.dependencies import require_executables
from audio_pipeline.scripts.errors import (
    AudioFileMissingError,
    ErrorCategory,
    InvalidMediaError,
    MissingDependencyError,
    TransientError,
    classify_exception,
)


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Validate pending audio import items."
    )
    parser.add_argument(
        "--job-id",
        type=int,
        default=None,
    )
    return parser.parse_args()


def _run(command, **kwargs):
    """Run an executable, separating tool problems from media problems.

    - executable missing        -> MissingDependencyError (SYSTEM_ERROR)
    - timeout                   -> TransientError
    """
    try:
        return subprocess.run(command, **kwargs)
    except FileNotFoundError as error:
        # The *program* was not found. This says nothing about the
        # audio file and must never mark a song failed.
        raise MissingDependencyError(
            f"Executable not found: {command[0]} ({error})"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise TransientError(
            f"{command[0]} timed out after {error.timeout}s"
        ) from error


def probe_audio(file_path):
    command = [
        "ffprobe",
        "-v", "error",
        "-show_entries",
        "format=duration,size:"
        "format_tags=title,artist,album",
        "-of", "json",
        str(file_path),
    ]

    result = _run(
        command,
        capture_output=True,
        text=True,
        timeout=120,
    )

    if result.returncode != 0:
        raise InvalidMediaError(
            result.stderr.strip() or "ffprobe could not read the file"
        )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise InvalidMediaError(
            f"Invalid ffprobe JSON: {error}"
        ) from error


def decode_audio(file_path):
    command = [
        "ffmpeg",
        "-v", "error",
        "-i", str(file_path),
        "-f", "null",
        "-",
    ]

    result = _run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=600,
    )

    message = result.stderr.strip()

    if result.returncode != 0:
        raise InvalidMediaError(message or "ffmpeg decoding failed")

    if message:
        return "WARNING", message

    return "OK", None


def validate_item(item):
    """Validate one item. Returns 'OK' or 'WARNING'.

    Raises a categorized error for anything else. The caller decides
    what each category does; nothing here marks a song failed.
    """
    item_id = item["id"]
    filename = item["original_filename"]
    local_path = item.get("local_file_path")

    print(f"\n[{item_id}] {filename}", flush=True)

    if not local_path:
        raise AudioFileMissingError("Local file path is missing.")

    file_path = Path(local_path)

    if not file_path.is_file():
        raise AudioFileMissingError(
            f"Audio file missing or invalid: {file_path}"
        )

    metadata = probe_audio(file_path)

    tags = metadata.get("format", {}).get("tags", {}) or {}
    # ffprobe tag-key case varies by container; match case-insensitively.
    lowered = {str(k).lower(): v for k, v in tags.items()}

    title = lowered.get("title")
    artist = lowered.get("artist")
    album = lowered.get("album")

    print(
        f"FFprobe OK | title={title} | "
        f"artist={artist} | album={album}",
        flush=True,
    )

    decode_status, message = decode_audio(file_path)

    status = "validated" if decode_status == "OK" else "warning"

    update_import_item_validation(
        item_id=item_id,
        status=status,
        title=title,
        artist=artist,
        album=album,
        failure_reason=message,
        original_metadata=tags,
        error_category=None,
    )

    return "OK" if decode_status == "OK" else "WARNING"


def handle_error(item, error):
    """Record a categorized error. SYSTEM_ERROR halts the run."""
    category = classify_exception(error)

    if category == ErrorCategory.SYSTEM_ERROR:
        raise error

    update = record_item_error(
        item["id"],
        category.value,
        f"Audio validation: {error}",
    )

    return category, update


def main():
    args = parse_arguments()

    # Halt before touching any song if the tools are not available.
    require_executables(("ffprobe", "ffmpeg"))

    if args.job_id is not None:
        job = get_import_job(args.job_id)
        if job is None:
            raise RuntimeError(
                f"Import job {args.job_id} does not exist."
            )

        print(f"Import job ID: {args.job_id}")
        print(f"Import run: {job['run_id']}")

        claimed = claim_due_retries(args.job_id)
        print(f"Retries due and re-queued: {claimed}")

    pending_items = get_pending_import_items(
        job_id=args.job_id
    )

    print(
        f"Pending items: {len(pending_items)}",
        flush=True,
    )

    validated = 0
    warnings = 0
    invalid = 0
    retrying = 0
    review = 0

    for item in pending_items:
        try:
            result = validate_item(item)
            if result == "OK":
                validated += 1
            else:
                warnings += 1
            print(f"[{item['id']}] {result}", flush=True)

        except Exception as error:
            category, _ = handle_error(item, error)

            if category == ErrorCategory.INVALID_MEDIA:
                invalid += 1
            elif category == ErrorCategory.MANUAL_REVIEW:
                review += 1
            else:
                retrying += 1

            print(
                f"[{item['id']}] {category.value}: {error}",
                flush=True,
            )

    print("\nAudio validation complete.")
    print(f"Validated: {validated}")
    print(f"Warnings: {warnings}")
    print(f"Invalid media (failed): {invalid}")
    print(f"Scheduled for retry: {retrying}")
    print(f"Manual review: {review}")


if __name__ == "__main__":
    main()
