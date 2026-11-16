import argparse
import os

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from audio_pipeline.scripts.db import (
    get_connection,
    get_import_job,
)
from audio_pipeline.scripts.drive_policy import (
    ALREADY_DONE,
    ARCHIVE,
    ARCHIVE_DUPLICATE,
    FAILED,
    FINISH_REMOVE,
    KEEP,
    MOVE,
    SKIP,
    plan_move,
    route_for_item,
)


TOKEN_FILE = os.getenv(
    "GOOGLE_DRIVE_TOKEN_FILE",
    "/home/rk/google_drive_token.json",
)

INCOMING_FOLDER_ID = "1QZWFD51jh4_gtHOBfi7bauhJLB9_QTaC"
ARCHIVE_FOLDER_ID = "1kDDuKxP8-gL3YnkA7q9djHIVrxLZExC3"
FAILED_FOLDER_ID = "1e0Do2V1IZucWVVQlwhErR8o4aM8h3q-I"

SCOPES = [
    "https://www.googleapis.com/auth/drive"
]


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            "Route Google Drive import files to "
            "Archive or FAILED."
        )
    )

    parser.add_argument(
        "--job-id",
        type=int,
        default=None,
        help=(
            "Process only Drive items belonging "
            "to this import job."
        ),
    )

    parser.add_argument(
        "--authorize-drive-moves",
        action="store_true",
        help=(
            "Actually move files in Google Drive. Without this flag "
            "the script only prints what it WOULD do (dry run)."
        ),
    )

    return parser.parse_args()


def get_import_items(job_id=None):
    connection = get_connection()

    query = """
        SELECT
            id,
            drive_file_id,
            original_filename,
            status,
            playback_validated,
            song_id,
            failure_reason,
            error_category
        FROM import_items
        WHERE drive_file_id IS NOT NULL
    """
    parameters = ()

    if job_id is not None:
        query += " AND job_id = %s"
        parameters = (job_id,)

    query += " ORDER BY id;"

    try:
        with connection.cursor() as cursor:
            cursor.execute(query, parameters)
            rows = cursor.fetchall()

        return [
            {
                "id": row[0],
                "drive_file_id": row[1],
                "filename": row[2],
                "status": row[3],
                "playback_validated": row[4],
                "song_id": row[5],
                "failure_reason": row[6],
                "error_category": row[7],
            }
            for row in rows
        ]

    finally:
        connection.close()


def determine_destination(item):
    """Return (destination_folder_id or None, action)."""
    action = route_for_item(item)

    if action == ARCHIVE or action == ARCHIVE_DUPLICATE:
        return ARCHIVE_FOLDER_ID, action

    if action == FAILED:
        return FAILED_FOLDER_ID, action

    return None, KEEP


def get_drive_file(drive, drive_file_id):
    return (
        drive.files()
        .get(
            fileId=drive_file_id,
            fields="id,name,parents,trashed",
        )
        .execute()
    )


def move_from_incoming(drive, drive_file_id, destination_folder_id):
    return (
        drive.files()
        .update(
            fileId=drive_file_id,
            addParents=destination_folder_id,
            removeParents=INCOMING_FOLDER_ID,
            fields="id,name,parents",
        )
        .execute()
    )


def finish_remove_from_incoming(drive, drive_file_id):
    return (
        drive.files()
        .update(
            fileId=drive_file_id,
            removeParents=INCOMING_FOLDER_ID,
            fields="id,name,parents",
        )
        .execute()
    )


def route_items(drive, items, authorized):
    """Route files. Idempotent; never raises for one bad file.

    A Drive failure leaves that file where it is (recoverable) and
    never changes the database. Without `authorized` nothing in
    Drive is modified.
    """
    counts = {
        "archived": 0,
        "duplicates": 0,
        "failed_folder": 0,
        "kept": 0,
        "already": 0,
        "skipped": 0,
        "dry_run": 0,
        "errors": 0,
    }

    for item in items:
        destination_id, action = determine_destination(item)

        print("-" * 72)
        print(f"Import {item['id']} | {item['filename']}")
        print(
            f"Status: {item['status']} | Category: "
            f"{item.get('error_category')} | "
            f"Playback: {item['playback_validated']} | "
            f"Song ID: {item['song_id']} | Action: {action}"
        )

        if destination_id is None:
            counts["kept"] += 1
            print("KEEP: file stays in INCOMING.")
            continue

        try:
            drive_file = get_drive_file(drive, item["drive_file_id"])

            step = plan_move(
                drive_file.get("parents", []),
                INCOMING_FOLDER_ID,
                destination_id,
                trashed=bool(drive_file.get("trashed")),
            )

            if step == SKIP:
                counts["skipped"] += 1
                print("SKIP: trashed or not in INCOMING.")
                continue

            if step == ALREADY_DONE:
                counts["already"] += 1
                print("Already in destination.")
                continue

            if not authorized:
                counts["dry_run"] += 1
                print(f"DRY RUN: would {step} -> {destination_id}")
                continue

            if step == MOVE:
                result = move_from_incoming(
                    drive, item["drive_file_id"], destination_id
                )
            else:  # FINISH_REMOVE after an earlier partial move
                result = finish_remove_from_incoming(
                    drive, item["drive_file_id"]
                )

            parents = result.get("parents", [])

            if destination_id not in parents or (
                INCOMING_FOLDER_ID in parents
            ):
                raise RuntimeError(
                    "Drive move not confirmed; file remains "
                    "recoverable and will be completed next run."
                )

            if action == ARCHIVE:
                counts["archived"] += 1
            elif action == ARCHIVE_DUPLICATE:
                counts["duplicates"] += 1
            else:
                counts["failed_folder"] += 1

            print(f"MOVED: {action}")

        except Exception as error:
            counts["errors"] += 1
            print(f"ERROR (file left in place): {error}")

    return counts


def main():
    args = parse_arguments()

    if args.job_id is not None:
        job = get_import_job(args.job_id)

        if job is None:
            raise RuntimeError(
                f"Import job {args.job_id} does not exist."
            )

        print(f"Import job ID: {args.job_id}")
        print(f"Import run: {job['run_id']}")

    items = get_import_items(job_id=args.job_id)

    mode = "AUTHORIZED" if args.authorize_drive_moves else "DRY RUN"
    print("=" * 72)
    print(f"GOOGLE DRIVE ROUTING ({mode})")
    print("=" * 72)
    print(f"Tracked Drive items: {len(items)}")

    credentials = Credentials.from_authorized_user_file(
        TOKEN_FILE,
        SCOPES,
    )
    drive = build("drive", "v3", credentials=credentials)

    counts = route_items(drive, items, args.authorize_drive_moves)

    print("=" * 72)
    for key, value in counts.items():
        print(f"{key:15} {value}")

    if counts["errors"]:
        raise RuntimeError(
            f"Drive routing finished with {counts['errors']} error(s); "
            "affected files were left in place."
        )


if __name__ == "__main__":
    main()
