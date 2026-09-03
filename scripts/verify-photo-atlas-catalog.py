#!/usr/bin/env python3
"""Verify the lazy-loadable Photoatlas catalog and every available pack.

This validator is intentionally independent of MediaPipe and the build-time
Python environment. It validates the closed-world catalog, local-path safety,
neutral public labels, evidence boundaries, artifact hashes, and the linkage
between each available atlas, its metadata, and its engineering QA report.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
from typing import Any

from photo_atlas_pack_common import (
    AFFECT_VALIDATION_BOUNDARY,
    CATALOG_EVIDENCE_BOUNDARY,
    CATALOG_SCHEMA,
    CATALOG_VERSION,
    CONSENT_BASIS,
    DEMOGRAPHIC_LABEL_SCOPE,
    IDENTITY_TYPE,
    PACK_METADATA_SCHEMA,
    PACK_METADATA_VERSION,
    PACK_QA_EVIDENCE_BOUNDARY,
    PACK_QA_SCHEMA,
    PACK_QA_VERSION,
    PRESENTATION_STYLES,
    REGIONAL_DESIGN_INSPIRATIONS,
    SOURCE_OWNERSHIP,
    sha256,
    validate_pack_id,
    validate_relative_asset_path,
    validate_sha256,
    validate_short_text,
)


DEFAULT_ASSET_ROOT = Path("site/assets/affect-face")
DEFAULT_CATALOG = DEFAULT_ASSET_ROOT / "photo-atlas-packs-v1.json"

CATALOG_FIELDS = {
    "schema",
    "version",
    "defaultPackId",
    "evidenceBoundary",
    "packs",
}
ENTRY_FIELDS = {
    "id",
    "label",
    "presentationStyle",
    "regionalDesignInspirations",
    "skinToneAudit",
    "atlas",
    "metadata",
    "qa",
    "available",
    "gridSize",
    "tileSize",
    "quality",
    "atlasSha256",
    "atlasBytes",
    "provenance",
}
CATALOG_PROVENANCE_FIELDS = {
    "identityType",
    "sourceOwnership",
    "demographicLabelType",
    "demographicLabelScope",
    "consentBasis",
    "license",
    "affectValidation",
}
EXPECTED_PROVENANCE = {
    "identityType": IDENTITY_TYPE,
    "sourceOwnership": SOURCE_OWNERSHIP,
    "demographicLabelType": "creator-prompt-inspiration-only",
    "demographicLabelScope": DEMOGRAPHIC_LABEL_SCOPE,
    "consentBasis": CONSENT_BASIS,
    "affectValidation": AFFECT_VALIDATION_BOUNDARY,
}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    result.add_argument("--asset-root", type=Path, default=DEFAULT_ASSET_ROOT)
    result.add_argument(
        "--expect-pack",
        action="append",
        default=[],
        help="Repeat to require a particular neutral pack ID.",
    )
    result.add_argument(
        "--require-all-available",
        action="store_true",
        help="Fail unless every declared pack is locally available and verified.",
    )
    return result


def expected_label(pack_id: str) -> str:
    if pack_id == "photo-reference-v3":
        return "Original portrait"
    number = int(pack_id.rsplit("-", 1)[1]) + 1
    return f"Synthetic preset {number:02d}"


def load_json(path: Path, field: str, errors: list[str]) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        errors.append(f"{field} could not be read as JSON: {error}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{field} must contain a JSON object.")
        return None
    return value


def local_asset(
    asset_root: Path,
    value: Any,
    field: str,
    suffix: str,
    errors: list[str],
) -> Path | None:
    try:
        relative = validate_relative_asset_path(value, field, suffix)
        candidate = asset_root.joinpath(*PurePosixPath(relative).parts).resolve()
        candidate.relative_to(asset_root)
        return candidate
    except (TypeError, ValueError) as error:
        errors.append(str(error))
        return None


def require_exact_fields(
    value: Any, expected: set[str], field: str, errors: list[str]
) -> bool:
    if not isinstance(value, dict):
        errors.append(f"{field} must be an object.")
        return False
    actual = set(value)
    if actual != expected:
        errors.append(
            f"{field} fields differ; missing={sorted(expected - actual)}, "
            f"extra={sorted(actual - expected)}."
        )
        return False
    return True


def validate_provenance(value: Any, field: str, errors: list[str]) -> None:
    if not require_exact_fields(value, CATALOG_PROVENANCE_FIELDS, field, errors):
        return
    for key, expected in EXPECTED_PROVENANCE.items():
        if value[key] != expected:
            errors.append(f"{field}.{key} changed the required guardrail.")
    try:
        validate_short_text(value["license"], f"{field}.license", 80)
    except (TypeError, ValueError) as error:
        errors.append(str(error))


def validate_reference_artifacts(
    entry: dict[str, Any],
    atlas_path: Path,
    metadata_path: Path,
    qa_path: Path,
    errors: list[str],
) -> None:
    metadata = load_json(metadata_path, f"{entry['id']} metadata", errors)
    qa = load_json(qa_path, f"{entry['id']} QA", errors)
    if metadata is None or qa is None:
        return
    expected_metadata = {
        "id": "affect-face-atlas-v3-landmark-warp-21x21",
        "output": atlas_path.name,
        "outputSha256": entry["atlasSha256"],
        "gridSize": entry["gridSize"],
        "tileSize": entry["tileSize"],
        "quality": entry["quality"],
    }
    for key, expected in expected_metadata.items():
        if metadata.get(key) != expected:
            errors.append(f"{entry['id']} legacy metadata {key} does not match catalog.")
    if qa.get("schema") != "affect-tracker-photo-atlas-engineering-qa":
        errors.append(f"{entry['id']} has an unsupported legacy QA schema.")
    if qa.get("version") != 1 or qa.get("passed") is not True:
        errors.append(f"{entry['id']} legacy engineering QA has not passed.")
    asset = qa.get("asset")
    if not isinstance(asset, dict):
        errors.append(f"{entry['id']} legacy QA asset record is missing.")
        return
    expected_asset = {
        "atlas": atlas_path.name,
        "atlasSha256": entry["atlasSha256"],
        "metadata": metadata_path.name,
        "metadataSha256": sha256(metadata_path),
        "gridSize": entry["gridSize"],
        "tileSize": entry["tileSize"],
    }
    for key, expected in expected_asset.items():
        if asset.get(key) != expected:
            errors.append(f"{entry['id']} legacy QA asset {key} is stale or mismatched.")
    checks = qa.get("checks")
    if not isinstance(checks, dict) or not checks or not all(
        value is True for value in checks.values()
    ):
        errors.append(f"{entry['id']} legacy QA contains a failed check.")


def validate_synthetic_artifacts(
    entry: dict[str, Any],
    atlas_path: Path,
    metadata_path: Path,
    qa_path: Path,
    errors: list[str],
) -> None:
    metadata = load_json(metadata_path, f"{entry['id']} metadata", errors)
    qa = load_json(qa_path, f"{entry['id']} QA", errors)
    if metadata is None or qa is None:
        return
    expected_metadata = {
        "schema": PACK_METADATA_SCHEMA,
        "version": PACK_METADATA_VERSION,
        "id": entry["id"],
        "label": entry["label"],
        "presentationStyle": entry["presentationStyle"],
        "regionalDesignInspirations": entry["regionalDesignInspirations"],
        "skinToneAudit": entry["skinToneAudit"],
        "output": atlas_path.name,
        "outputSha256": entry["atlasSha256"],
        "gridSize": entry["gridSize"],
        "tileSize": entry["tileSize"],
        "quality": entry["quality"],
    }
    for key, expected in expected_metadata.items():
        if metadata.get(key) != expected:
            errors.append(f"{entry['id']} metadata {key} does not match catalog.")
    if metadata.get("nodeCount") != entry["gridSize"] ** 2:
        errors.append(f"{entry['id']} metadata nodeCount does not match gridSize.")
    if metadata.get("affectValidation") != AFFECT_VALIDATION_BOUNDARY:
        errors.append(f"{entry['id']} metadata affect boundary was weakened.")
    source_path = metadata_path.parent / str(metadata.get("source", ""))
    if source_path.name != "anchors-v1.png" or source_path.parent != metadata_path.parent:
        errors.append(f"{entry['id']} metadata source must be the colocated anchors-v1.png.")
    elif not source_path.is_file():
        errors.append(f"{entry['id']} source anchor asset is missing: {source_path}")
    elif metadata.get("sourceSha256") != sha256(source_path):
        errors.append(f"{entry['id']} source anchor hash is stale or mismatched.")
    metadata_provenance = metadata.get("provenance")
    if not isinstance(metadata_provenance, dict):
        errors.append(f"{entry['id']} metadata provenance is missing.")
    else:
        for key, expected in entry["provenance"].items():
            if metadata_provenance.get(key) != expected:
                errors.append(f"{entry['id']} metadata provenance {key} mismatches catalog.")

    if qa.get("schema") != PACK_QA_SCHEMA or qa.get("version") != PACK_QA_VERSION:
        errors.append(f"{entry['id']} has an unsupported pack QA schema/version.")
    if qa.get("passed") is not True:
        errors.append(f"{entry['id']} pack engineering QA has not passed.")
    if qa.get("evidenceBoundary") != PACK_QA_EVIDENCE_BOUNDARY:
        errors.append(f"{entry['id']} QA evidence boundary was weakened.")
    pack = qa.get("pack")
    expected_pack = {
        "id": entry["id"],
        "label": entry["label"],
        "presentationStyle": entry["presentationStyle"],
        "regionalDesignInspirations": entry["regionalDesignInspirations"],
        "skinToneAudit": entry["skinToneAudit"],
    }
    if pack != expected_pack:
        errors.append(f"{entry['id']} QA pack record does not match catalog.")
    asset = qa.get("asset")
    if not isinstance(asset, dict):
        errors.append(f"{entry['id']} QA asset record is missing.")
    else:
        expected_asset = {
            "atlas": atlas_path.name,
            "atlasSha256": entry["atlasSha256"],
            "metadata": metadata_path.name,
            "metadataSha256": sha256(metadata_path),
            "gridSize": entry["gridSize"],
            "tileSize": entry["tileSize"],
            "quality": entry["quality"],
        }
        for key, expected in expected_asset.items():
            if asset.get(key) != expected:
                errors.append(f"{entry['id']} QA asset {key} is stale or mismatched.")
        current_tools = {
            "denseBuilderSha256": sha256(Path(__file__).with_name("build-dense-photo-atlas.py")),
            "packBuilderSha256": sha256(Path(__file__).with_name("build-photo-atlas-pack.py")),
            "packCommonSha256": sha256(Path(__file__).with_name("photo_atlas_pack_common.py")),
            "coreVerifierSha256": sha256(Path(__file__).with_name("verify-dense-photo-atlas.py")),
            "packVerifierSha256": sha256(Path(__file__).with_name("verify-photo-atlas-pack.py")),
        }
        for key, expected in current_tools.items():
            if asset.get(key) != expected:
                errors.append(f"{entry['id']} QA asset {key} does not bind the current tool.")
    for check_group in ("checks", "coreChecks"):
        checks = qa.get(check_group)
        if not isinstance(checks, dict) or not checks or not all(
            value is True for value in checks.values()
        ):
            errors.append(f"{entry['id']} QA {check_group} contains a failed check.")


def validate_available_artifacts(
    entry: dict[str, Any],
    atlas_path: Path | None,
    metadata_path: Path | None,
    qa_path: Path | None,
    errors: list[str],
) -> None:
    paths = (atlas_path, metadata_path, qa_path)
    if any(path is None for path in paths):
        return
    assert atlas_path is not None and metadata_path is not None and qa_path is not None
    for kind, path in (("atlas", atlas_path), ("metadata", metadata_path), ("QA", qa_path)):
        if not path.is_file():
            errors.append(f"{entry['id']} available {kind} asset is missing: {path}")
    if not all(path.is_file() for path in paths):
        return
    actual_hash = sha256(atlas_path)
    if entry["atlasSha256"] != actual_hash:
        errors.append(f"{entry['id']} atlas SHA-256 does not match catalog.")
    if entry["atlasBytes"] != atlas_path.stat().st_size:
        errors.append(f"{entry['id']} atlas byte count does not match catalog.")
    if entry["id"] == "photo-reference-v3":
        validate_reference_artifacts(entry, atlas_path, metadata_path, qa_path, errors)
    else:
        validate_synthetic_artifacts(entry, atlas_path, metadata_path, qa_path, errors)


def validate_entry(
    entry: Any,
    index: int,
    asset_root: Path,
    errors: list[str],
) -> tuple[str | None, tuple[str, str, str] | None]:
    field = f"packs[{index}]"
    if not require_exact_fields(entry, ENTRY_FIELDS, field, errors):
        return None, None
    pack_id = entry["id"]
    try:
        validate_pack_id(pack_id)
    except (TypeError, ValueError) as error:
        errors.append(f"{field}.id: {error}")
        return None, None
    expected_public_label = expected_label(pack_id)
    if entry["label"] != expected_public_label:
        errors.append(
            f"{pack_id} public label must be neutral and exactly {expected_public_label!r}."
        )
    reference = pack_id == "photo-reference-v3"
    style = entry["presentationStyle"]
    if not isinstance(style, str) or style not in PRESENTATION_STYLES:
        errors.append(f"{pack_id} has an unsupported presentationStyle.")
    elif reference != (style == "reference"):
        errors.append(f"{pack_id} reference/synthetic presentationStyle is inconsistent.")
    inspirations = entry["regionalDesignInspirations"]
    inspirations_are_strings = isinstance(inspirations, list) and all(
        isinstance(item, str) for item in inspirations
    )
    if (
        not inspirations_are_strings
        or len(inspirations) != len(set(inspirations))
        or len(inspirations) > 4
        or any(item not in REGIONAL_DESIGN_INSPIRATIONS for item in inspirations)
    ):
        errors.append(f"{pack_id} has an invalid internal inspiration list.")
    if reference and inspirations != []:
        errors.append("photo-reference-v3 must not add regional prompt-inspiration metadata.")
    audit = entry["skinToneAudit"]
    if audit is not None:
        if not isinstance(audit, dict) or set(audit) != {"status", "descriptor"}:
            errors.append(f"{pack_id} skinToneAudit has invalid fields.")
        elif audit["status"] != "unvalidated":
            errors.append(f"{pack_id} skinToneAudit must remain unvalidated.")
        else:
            try:
                validate_short_text(audit["descriptor"], f"{pack_id} audit descriptor", 160)
            except (TypeError, ValueError) as error:
                errors.append(str(error))
    if reference and audit is not None:
        errors.append("photo-reference-v3 must not add an unperformed skin-tone audit.")
    validate_provenance(entry["provenance"], f"{pack_id}.provenance", errors)

    if type(entry["available"]) is not bool:
        errors.append(f"{pack_id}.available must be a JSON boolean.")
    for numeric in ("gridSize", "tileSize", "quality"):
        if type(entry[numeric]) is not int or entry[numeric] <= 0:
            errors.append(f"{pack_id}.{numeric} must be a positive integer.")
    if type(entry["gridSize"]) is int and entry["gridSize"] % 2 != 1:
        errors.append(f"{pack_id}.gridSize must be odd so zero is represented.")
    available = entry["available"] is True
    grid_is_integer = type(entry["gridSize"]) is int and entry["gridSize"] > 0
    tile_is_integer = type(entry["tileSize"]) is int and entry["tileSize"] > 0
    quality_is_integer = type(entry["quality"]) is int and 1 <= entry["quality"] <= 100
    if not quality_is_integer:
        errors.append(f"{pack_id}.quality must be between 1 and 100.")
    if available:
        try:
            validate_sha256(entry["atlasSha256"], f"{pack_id}.atlasSha256")
        except (TypeError, ValueError) as error:
            errors.append(str(error))
        if type(entry["atlasBytes"]) is not int or entry["atlasBytes"] <= 0:
            errors.append(f"{pack_id}.atlasBytes must be a positive integer when available.")
    elif entry["atlasSha256"] is not None or entry["atlasBytes"] is not None:
        errors.append(f"{pack_id} unavailable entries must not advertise an atlas hash or size.")

    if reference:
        expected_paths = (
            "affect-face-atlas-v3.webp",
            "affect-face-atlas-v3.json",
            "affect-face-atlas-v3-qa.json",
        )
    else:
        prefix = f"packs/{pack_id}"
        expected_paths = (
            f"{prefix}/atlas-v1.webp",
            f"{prefix}/atlas-v1.json",
            f"{prefix}/atlas-v1-qa.json",
        )
    actual_paths = (entry["atlas"], entry["metadata"], entry["qa"])
    if actual_paths != expected_paths:
        errors.append(f"{pack_id} asset paths do not follow the closed-world pack convention.")
    atlas_path = local_asset(asset_root, entry["atlas"], f"{pack_id}.atlas", ".webp", errors)
    metadata_path = local_asset(
        asset_root, entry["metadata"], f"{pack_id}.metadata", ".json", errors
    )
    qa_path = local_asset(asset_root, entry["qa"], f"{pack_id}.qa", ".json", errors)
    if available and grid_is_integer and tile_is_integer and quality_is_integer:
        validate_available_artifacts(entry, atlas_path, metadata_path, qa_path, errors)
    return pack_id, actual_paths if all(isinstance(item, str) for item in actual_paths) else None


def validate_catalog(args: argparse.Namespace) -> dict[str, Any]:
    catalog_path = args.catalog.resolve()
    asset_root = args.asset_root.resolve()
    errors: list[str] = []
    catalog = load_json(catalog_path, "catalog", errors)
    if catalog is None:
        return {"passed": False, "catalog": str(catalog_path), "errors": errors}
    require_exact_fields(catalog, CATALOG_FIELDS, "catalog", errors)
    if catalog.get("schema") != CATALOG_SCHEMA or catalog.get("version") != CATALOG_VERSION:
        errors.append("Catalog schema/version is unsupported.")
    if catalog.get("evidenceBoundary") != CATALOG_EVIDENCE_BOUNDARY:
        errors.append("Catalog evidence boundary is missing or weakened.")
    packs = catalog.get("packs")
    if not isinstance(packs, list) or not packs:
        errors.append("catalog.packs must be a non-empty array.")
        packs = []

    pack_ids: list[str] = []
    all_paths: list[str] = []
    available_ids: list[str] = []
    for index, entry in enumerate(packs):
        pack_id, paths = validate_entry(entry, index, asset_root, errors)
        if pack_id is not None:
            pack_ids.append(pack_id)
            if isinstance(entry, dict) and entry.get("available") is True:
                available_ids.append(pack_id)
        if paths is not None:
            all_paths.extend(paths)
    if len(pack_ids) != len(set(pack_ids)):
        errors.append("Catalog pack IDs must be unique.")
    if len(all_paths) != len(set(all_paths)):
        errors.append("Catalog asset paths must not be shared between packs.")
    default_pack_id = catalog.get("defaultPackId")
    if default_pack_id not in pack_ids:
        errors.append("defaultPackId does not name a declared pack.")
    elif default_pack_id not in available_ids:
        errors.append("defaultPackId must be locally available.")
    for value in args.expect_pack:
        try:
            expected = validate_pack_id(value)
        except (TypeError, ValueError) as error:
            errors.append(f"Invalid --expect-pack value {value!r}: {error}")
        else:
            if expected not in pack_ids:
                errors.append(f"Expected pack is not declared: {expected}")
    if args.require_all_available and len(available_ids) != len(pack_ids):
        unavailable = sorted(set(pack_ids) - set(available_ids))
        errors.append(f"Not all packs are available: {unavailable}")

    return {
        "passed": not errors,
        "catalog": str(catalog_path),
        "catalogSha256": sha256(catalog_path),
        "packCount": len(pack_ids),
        "availablePackCount": len(available_ids),
        "packIds": pack_ids,
        "availablePackIds": available_ids,
        "errors": errors,
    }


def main() -> None:
    args = parser().parse_args()
    report = validate_catalog(args)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
