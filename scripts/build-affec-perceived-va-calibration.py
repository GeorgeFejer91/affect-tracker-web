#!/usr/bin/env python3
"""Reproduce the public AFFEC perceived-valence/arousal evidence artifact.

The script reads the official CC BY 4.0 ``core.zip`` directly and emits only
six category-level counts, means, and sample standard deviations. It never
copies participant identifiers, trial rows, stimulus paths, or demographics.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import statistics
import sys
import zipfile
from pathlib import Path, PurePosixPath


SOURCE_RECORD = "https://zenodo.org/records/14794876"
SOURCE_DOI = "10.5281/zenodo.14794876"
SOURCE_ARCHIVE_BYTES = 5_645_457
SOURCE_ARCHIVE_MD5 = "7157e9bedacf58f42692688fb20b57b1"
SOURCE_ARCHIVE_SHA256 = "f5b71a3360a21e05d01f92172ea52bbcc6bb4a763f181da10b8e63af2faf7e99"
EXPECTED_FILE_COUNT = 273
EXPECTED_VALID_TRIAL_COUNT = 5_807
EMOTIONS = ("angry", "disgust", "fear", "happy", "neutral", "sad")


def digest(path: Path, algorithm: str) -> str:
    checksum = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def is_behavior_table(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        len(path.parts) == 3
        and path.parts[0].startswith("sub-")
        and path.parts[1] == "beh"
        and path.name.endswith("_beh.tsv")
    )


def aggregate(core_zip: Path) -> dict[str, object]:
    if core_zip.stat().st_size != SOURCE_ARCHIVE_BYTES:
        raise ValueError(f"Unexpected core.zip byte length: {core_zip.stat().st_size}")
    if digest(core_zip, "md5") != SOURCE_ARCHIVE_MD5:
        raise ValueError("core.zip does not match the AFFEC Zenodo MD5")
    if digest(core_zip, "sha256") != SOURCE_ARCHIVE_SHA256:
        raise ValueError("core.zip does not match the locally pinned SHA-256")

    grouped: dict[str, list[tuple[float, float]]] = {emotion: [] for emotion in EMOTIONS}
    with zipfile.ZipFile(core_zip) as archive:
        names = sorted(name for name in archive.namelist() if is_behavior_table(name))
        if len(names) != EXPECTED_FILE_COUNT:
            raise ValueError(f"Expected {EXPECTED_FILE_COUNT} behavioral tables, found {len(names)}")
        for name in names:
            with archive.open(name) as binary:
                rows = csv.DictReader(io.TextIOWrapper(binary, encoding="utf-8-sig"), delimiter="\t")
                required = {"trial_type", "p_emotion_v", "p_emotion_a"}
                if not required.issubset(rows.fieldnames or ()):
                    raise ValueError(f"Missing perceived-rating fields in {name}")
                for row in rows:
                    emotion = (row.get("trial_type") or "").strip().lower()
                    if emotion not in grouped:
                        continue
                    try:
                        valence = float(row["p_emotion_v"])
                        arousal = float(row["p_emotion_a"])
                    except (TypeError, ValueError):
                        continue
                    if 1 <= valence <= 9 and 1 <= arousal <= 9:
                        grouped[emotion].append((valence, arousal))

    valid_trial_count = sum(len(values) for values in grouped.values())
    if valid_trial_count != EXPECTED_VALID_TRIAL_COUNT:
        raise ValueError(
            f"Expected {EXPECTED_VALID_TRIAL_COUNT} valid trials, found {valid_trial_count}"
        )

    anchors = []
    for emotion in EMOTIONS:
        values = grouped[emotion]
        valence = [value[0] for value in values]
        arousal = [value[1] for value in values]
        mean_valence = statistics.mean(valence)
        mean_arousal = statistics.mean(arousal)
        sd_valence = statistics.stdev(valence)
        sd_arousal = statistics.stdev(arousal)
        anchors.append(
            {
                "id": f"affec-perceived-{emotion}-v0.1",
                "sourceCategory": emotion,
                "n": len(values),
                "sourceMean": {
                    "valence": round(mean_valence, 6),
                    "arousal": round(mean_arousal, 6),
                },
                "sourceSampleSd": {
                    "valence": round(sd_valence, 6),
                    "arousal": round(sd_arousal, 6),
                },
                "normalizedMean": {
                    "x": round((mean_valence - 5) / 4, 8),
                    "y": round((mean_arousal - 5) / 4, 8),
                },
                "normalizedSampleSd": {
                    "x": round(sd_valence / 4, 8),
                    "y": round(sd_arousal / 4, 8),
                },
            }
        )

    return {
        "schema": "affect-tracker-affec-perceived-va-evidence",
        "version": 1,
        "id": "affec-perceived-va-evidence-v1",
        "evidenceClass": "dataset-derived-aggregate",
        "source": {
            "datasetId": "AFFEC",
            "title": "AFFEC Multimodal Dataset",
            "version": "0.1",
            "doi": SOURCE_DOI,
            "record": SOURCE_RECORD,
            "archive": {
                "name": "core.zip",
                "bytes": SOURCE_ARCHIVE_BYTES,
                "md5": SOURCE_ARCHIVE_MD5,
                "sha256": SOURCE_ARCHIVE_SHA256,
            },
            "licensePolicy": "CC BY 4.0 per the Zenodo record; the devkit currently describes dataset files as CC0, so this project follows the more conservative attribution path.",
        },
        "coordinateSystem": {
            "id": "affec-perceived-va-9-point",
            "axes": {"x": "perceived valence", "y": "perceived arousal"},
            "sourceRange": [1, 9],
            "neutral": 5,
            "runtimeRange": [-1, 1],
            "transform": "(rating - 5) / 4",
        },
        "aggregation": {
            "behaviorTableCount": EXPECTED_FILE_COUNT,
            "validObservationCount": valid_trial_count,
            "groupBy": "trial_type",
            "ratingFields": ["p_emotion_v", "p_emotion_a"],
            "inclusionRule": "both perceived ratings are numeric and within [1, 9]",
            "statistics": "arithmetic mean and sample standard deviation",
            "privacy": "Only category aggregates are emitted; participant identifiers, demographics, stimulus paths, and trial rows are excluded.",
        },
        "anchors": anchors,
        "derivation": {
            "script": "scripts/build-affec-perceived-va-calibration.py",
            "scriptSha256": digest(Path(__file__).resolve(), "sha256"),
        },
        "claimScope": {
            "supports": ["aggregate-perceived-category-location"],
            "doesNotSupport": [
                "portrait-expression-validity",
                "individual-affect-inference",
                "emotion-recognition",
                "demographic-inference",
                "diagnosis",
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core-zip", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Compare the generated bytes with --output instead of writing it.",
    )
    args = parser.parse_args()
    rendered = json.dumps(aggregate(args.core_zip), indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding="utf-8") != rendered:
            print(f"Calibration differs from {args.output}", file=sys.stderr)
            return 1
        print(f"Calibration matches {args.output}")
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
