#!/usr/bin/env python3
"""Verify one synthetic Photoatlas pack and emit its activatable catalog entry.

The verifier reproduces RGB-matte preparation from metadata, then delegates
landmark/topology/continuity/anchor checks to the unchanged v3 engineering QA
implementation. Passing geometry is not perceived-affect or demographic
validation; the report preserves that evidence boundary explicitly.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from photo_atlas_pack_common import (
    AFFECT_VALIDATION_BOUNDARY,
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
    atomic_write_json,
    catalog_entry_from_metadata,
    load_module,
    prepare_source_rgba,
    sha256,
    validate_pack_id,
    validate_short_text,
)


DEFAULT_ASSET_ROOT = Path("site/assets/affect-face")
DEFAULT_BUILDER = Path("scripts/build-dense-photo-atlas.py")
DEFAULT_CORE_VERIFIER = Path("scripts/verify-dense-photo-atlas.py")

def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--pack-id", required=True)
    result.add_argument("--asset-root", type=Path, default=DEFAULT_ASSET_ROOT)
    result.add_argument("--source", type=Path, default=None)
    result.add_argument("--atlas", type=Path, default=None)
    result.add_argument("--metadata", type=Path, default=None)
    result.add_argument("--report", type=Path, default=None)
    result.add_argument("--html", type=Path, default=None)
    result.add_argument("--catalog-entry-out", type=Path, default=None)
    result.add_argument("--builder", type=Path, default=DEFAULT_BUILDER)
    result.add_argument("--core-verifier", type=Path, default=DEFAULT_CORE_VERIFIER)
    return result


def resolved_paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path, Path]:
    asset_root = args.asset_root.resolve()
    pack_directory = asset_root / "packs" / args.pack_id
    source_path = (args.source or pack_directory / "anchors-v1.png").resolve()
    atlas_path = (args.atlas or pack_directory / "atlas-v1.webp").resolve()
    metadata_path = (args.metadata or pack_directory / "atlas-v1.json").resolve()
    report_path = (args.report or pack_directory / "atlas-v1-qa.json").resolve()
    return asset_root, source_path, atlas_path, metadata_path, report_path


def validate_metadata(metadata: dict, pack_id: str) -> None:
    required = {
        "schema",
        "version",
        "id",
        "label",
        "presentationStyle",
        "regionalDesignInspirations",
        "skinToneAudit",
        "source",
        "sourceSha256",
        "preparedSourceSha256",
        "sourcePreprocessing",
        "output",
        "outputSha256",
        "sourceGridSize",
        "gridSize",
        "nodeCount",
        "tileSize",
        "quality",
        "controlPointCount",
        "triangleCount",
        "topologySweepSize",
        "minimumTriangleAreaPixels",
        "method",
        "runtimeInterpolation",
        "affectValidation",
        "versions",
        "tooling",
        "provenance",
    }
    if set(metadata) != required:
        missing = sorted(required - set(metadata))
        extra = sorted(set(metadata) - required)
        raise ValueError(f"Metadata field mismatch; missing={missing}, extra={extra}.")
    if metadata["schema"] != PACK_METADATA_SCHEMA or metadata["version"] != PACK_METADATA_VERSION:
        raise ValueError("Unsupported Photoatlas pack metadata schema/version.")
    if metadata["id"] != pack_id:
        raise ValueError("Metadata pack ID does not match --pack-id.")
    validate_pack_id(metadata["id"])
    validate_short_text(metadata["label"], "metadata.label", 80)
    if metadata["presentationStyle"] not in PRESENTATION_STYLES - {"reference"}:
        raise ValueError("Synthetic packs require a creator-selected presentation style.")
    inspirations = metadata["regionalDesignInspirations"]
    inspirations_are_strings = isinstance(inspirations, list) and all(
        isinstance(item, str) for item in inspirations
    )
    if (
        not inspirations_are_strings
        or len(inspirations) != len(set(inspirations))
        or len(inspirations) > 4
        or any(item not in REGIONAL_DESIGN_INSPIRATIONS for item in inspirations)
    ):
        raise ValueError("Invalid internal regional design inspiration list.")
    audit = metadata["skinToneAudit"]
    if audit is not None:
        if set(audit) != {"status", "descriptor"} or audit["status"] != "unvalidated":
            raise ValueError("Skin-tone audit metadata must remain explicitly unvalidated.")
        validate_short_text(audit["descriptor"], "skinToneAudit.descriptor", 160)
    provenance = metadata["provenance"]
    if not isinstance(provenance, dict):
        raise ValueError("Metadata provenance must be an object.")
    fixed = {
        "identityType": IDENTITY_TYPE,
        "sourceOwnership": SOURCE_OWNERSHIP,
        "demographicLabelType": "creator-prompt-inspiration-only",
        "demographicLabelScope": DEMOGRAPHIC_LABEL_SCOPE,
        "consentBasis": CONSENT_BASIS,
        "affectValidation": AFFECT_VALIDATION_BOUNDARY,
    }
    for key, value in fixed.items():
        if provenance.get(key) != value:
            raise ValueError(f"Provenance guardrail {key} is missing or changed.")
    if metadata["affectValidation"] != AFFECT_VALIDATION_BOUNDARY:
        raise ValueError("The pack affect-validation boundary must not be weakened.")
    if metadata["sourceGridSize"] != 3:
        raise ValueError("Pack source must be a 3x3 anchor sheet.")
    if type(metadata["gridSize"]) is not int or metadata["gridSize"] < 3 or metadata["gridSize"] % 2 == 0:
        raise ValueError("Pack grid must be odd and centered.")
    if metadata["nodeCount"] != metadata["gridSize"] ** 2:
        raise ValueError("Pack node count does not match its grid.")
    if type(metadata["quality"]) is not int or not 1 <= metadata["quality"] <= 100:
        raise ValueError("Pack WebP quality must be an integer from 1 to 100.")
    tooling = metadata["tooling"]
    expected_tooling = {
        "denseBuilder",
        "denseBuilderSha256",
        "packBuilder",
        "packBuilderSha256",
        "packCommon",
        "packCommonSha256",
    }
    if not isinstance(tooling, dict) or set(tooling) != expected_tooling:
        raise ValueError("Pack tooling must bind the dense builder, wrapper, and matte helper.")


def verify(args: argparse.Namespace) -> tuple[dict, dict, Path]:
    pack_id = validate_pack_id(args.pack_id)
    if pack_id == "photo-reference-v3":
        raise ValueError(
            "Use verify-dense-photo-atlas.py for the immutable legacy reference pack."
        )
    asset_root, source_path, atlas_path, metadata_path, report_path = resolved_paths(args)
    for path in (source_path, atlas_path, metadata_path):
        if not path.is_file():
            raise FileNotFoundError(f"Required pack artifact does not exist: {path}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    validate_metadata(metadata, pack_id)
    builder_path = args.builder.resolve()
    core_verifier_path = args.core_verifier.resolve()
    common_path = Path(__file__).with_name("photo_atlas_pack_common.py").resolve()
    builder = load_module(builder_path, "affect_dense_atlas_builder_for_pack_qa")
    core_verifier = load_module(core_verifier_path, "affect_dense_atlas_core_qa")

    preprocessing_config = metadata["sourcePreprocessing"]
    if not isinstance(preprocessing_config, dict):
        raise ValueError("sourcePreprocessing must be an object.")
    method = preprocessing_config.get("method")
    if method == "preserve-source-alpha-v1":
        matte_mode = "preserve-alpha"
        black_point, opaque_point = 8, 24
    elif method == "cell-border-connected-rgb-black-matte-soft-alpha-v2":
        matte_mode = "black"
        black_point = int(preprocessing_config["blackPoint"])
        opaque_point = int(preprocessing_config["opaquePoint"])
    else:
        raise ValueError(f"Unsupported source preprocessing method: {method!r}")

    with tempfile.TemporaryDirectory(prefix=f".{pack_id}-qa-", dir=atlas_path.parent) as name:
        temporary = Path(name)
        prepared_path = temporary / source_path.name
        reproduced_preprocessing = prepare_source_rgba(
            source_path,
            prepared_path,
            builder,
            matte_mode,
            black_point,
            opaque_point,
        )
        compatibility_metadata = dict(metadata)
        compatibility_metadata["source"] = prepared_path.name
        compatibility_metadata["sourceSha256"] = sha256(prepared_path)
        compatibility_metadata_path = temporary / metadata_path.name
        atomic_write_json(compatibility_metadata_path, compatibility_metadata)
        core_report = core_verifier.verify(
            SimpleNamespace(
                builder=builder_path,
                source=prepared_path,
                atlas=atlas_path,
                metadata=compatibility_metadata_path,
            )
        )

    tooling = metadata["tooling"]
    if not isinstance(tooling, dict):
        raise ValueError("tooling must be an object.")
    checks = {
        "coreEngineeringQaPassed": core_report["passed"],
        "sourceFilenameMatchesMetadata": source_path.name == metadata["source"],
        "sourceHashMatchesMetadata": sha256(source_path) == metadata["sourceSha256"],
        "preparedSourceHashMatchesMetadata": (
            reproduced_preprocessing["preparedSha256"]
            == metadata["preparedSourceSha256"]
        ),
        "sourcePreprocessingReproducesExactly": (
            reproduced_preprocessing == metadata["sourcePreprocessing"]
        ),
        "softMatteRgbIsNotAmplified": (
            method == "preserve-source-alpha-v1"
            or reproduced_preprocessing["softPixelMaximumRgb"] < opaque_point
        ),
        "atlasFilenameMatchesMetadata": atlas_path.name == metadata["output"],
        "atlasHashMatchesMetadata": sha256(atlas_path) == metadata["outputSha256"],
        "denseBuilderHashMatchesMetadata": (
            tooling.get("denseBuilderSha256") == sha256(builder_path)
        ),
        "packBuilderHashMatchesMetadata": (
            tooling.get("packBuilderSha256")
            == sha256(Path(__file__).with_name("build-photo-atlas-pack.py"))
        ),
        "packCommonHashMatchesMetadata": (
            tooling.get("packCommonSha256") == sha256(common_path)
        ),
        "toolFilenamesMatchMetadata": (
            tooling.get("denseBuilder") == builder_path.name
            and tooling.get("packBuilder")
            == Path(__file__).with_name("build-photo-atlas-pack.py").name
            and tooling.get("packCommon") == common_path.name
        ),
        "evidenceBoundariesRemainExplicit": (
            metadata["affectValidation"] == AFFECT_VALIDATION_BOUNDARY
            and metadata["provenance"].get("demographicLabelScope")
            == DEMOGRAPHIC_LABEL_SCOPE
        ),
    }
    report = {
        "schema": PACK_QA_SCHEMA,
        "version": PACK_QA_VERSION,
        "passed": all(checks.values()),
        "evidenceBoundary": PACK_QA_EVIDENCE_BOUNDARY,
        "pack": {
            "id": metadata["id"],
            "label": metadata["label"],
            "presentationStyle": metadata["presentationStyle"],
            "regionalDesignInspirations": metadata["regionalDesignInspirations"],
            "skinToneAudit": metadata["skinToneAudit"],
        },
        "asset": {
            "source": source_path.name,
            "sourceSha256": sha256(source_path),
            "preparedSourceSha256": reproduced_preprocessing["preparedSha256"],
            "atlas": atlas_path.name,
            "atlasSha256": sha256(atlas_path),
            "metadata": metadata_path.name,
            "metadataSha256": sha256(metadata_path),
            "denseBuilder": builder_path.name,
            "denseBuilderSha256": sha256(builder_path),
            "packBuilder": Path(__file__).with_name("build-photo-atlas-pack.py").name,
            "packBuilderSha256": sha256(Path(__file__).with_name("build-photo-atlas-pack.py")),
            "packCommon": common_path.name,
            "packCommonSha256": sha256(common_path),
            "coreVerifier": core_verifier_path.name,
            "coreVerifierSha256": sha256(core_verifier_path),
            "packVerifier": Path(__file__).name,
            "packVerifierSha256": sha256(Path(__file__).resolve()),
            "gridSize": metadata["gridSize"],
            "tileSize": metadata["tileSize"],
            "quality": metadata["quality"],
            "detectedCellCount": core_report["asset"]["detectedCellCount"],
        },
        "sourcePreprocessing": reproduced_preprocessing,
        "checks": checks,
        "coreChecks": core_report["checks"],
        "thresholds": core_report["thresholds"],
        "metrics": core_report["metrics"],
    }
    atomic_write_json(report_path, report)
    if args.html:
        core_verifier.make_html(args.html.resolve(), atlas_path, report)
    if args.catalog_entry_out:
        entry = catalog_entry_from_metadata(
            metadata,
            asset_root,
            atlas_path,
            metadata_path,
            report_path,
            available=report["passed"],
        )
        atomic_write_json(args.catalog_entry_out.resolve(), entry)
    return report, metadata, report_path


def main() -> None:
    args = parser().parse_args()
    report, _metadata, _report_path = verify(args)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
