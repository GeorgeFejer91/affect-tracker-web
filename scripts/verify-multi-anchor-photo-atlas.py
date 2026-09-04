#!/usr/bin/env python3
"""Verify the photo-synthetic-08 5x5-to-21x21 Photoatlas artifact.

This verifier is intentionally separate from the hash-locked legacy 3x3
pipeline.  It verifies deterministic asset lineage, source/output face
detection, landmark-warp topology and continuity, and preservation of every
generated 5x5 source anchor at its exact 21x21 output node.  Progress metrics
are diagnostic engineering proxies only; they do not validate perceived
valence or arousal.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any


PACK_ID = "photo-synthetic-08"
SOURCE_GRID_SIZE = 5
SOURCE_ANCHOR_COUNT = 25
ADDITIONAL_GRID_POSITION_COUNT = 16
REFERENCE_GRID_SIZE = 3
REFERENCE_ANCHOR_COUNT = 9
DENSE_GRID_SIZE = 21
DENSE_NODE_COUNT = 441
TILE_SIZE = 160
ANCHOR_OUTPUT_INDICES = [0, 5, 10, 15, 20]
EXPECTED_ATLAS_PIXELS = DENSE_GRID_SIZE * TILE_SIZE
EXPECTED_DECODED_RGBA_BYTES = EXPECTED_ATLAS_PIXELS**2 * 4

QA_SCHEMA = "affect-tracker-photo-atlas-multi-anchor-engineering-qa"
QA_VERSION = 1
METADATA_SCHEMA = "affect-tracker-photo-atlas-multi-anchor-pack"
METADATA_VERSION = 1
AUTHORING_SCHEMA = "affect-tracker-photo-atlas-image-to-image-authoring"
AUTHORING_VERSION = 1

EVIDENCE_BOUNDARY = (
    "Engineering QA of one project-authored synthetic 5x5 anchor sheet and its "
    "deterministic 21x21 atlas only. The 25 generated anchors include 16 "
    "additional grid positions relative to a reference-only 3x3 layout; the "
    "original nine reference cells are not asserted to be byte-preserved. "
    "Landmark, topology, continuity, and image checks do not establish perceived "
    "or validated valence/arousal, demographic identity, emotion recognition, "
    "or diagnosis. No participant media or annotations are used."
)
REFERENCE_ROLE = (
    "The original 3x3 atlas is an image-to-image authoring reference only; its "
    "nine cells are not asserted to be byte-preserved in the generated 5x5 sheet."
)

THRESHOLDS = {
    "anchorMinimumForegroundRgbPsnrDb": 35.0,
    "anchorMaximumAlphaError": 0,
    "landmarkMedianErrorPixels": 1.0,
    "landmarkP95ErrorPixels": 1.5,
    "landmarkMaximumErrorPixels": 3.0,
    "neighborContinuityP95ResidualPixels": 1.5,
    "diagonalContinuityP95ResidualPixels": 2.25,
    "atlasMaximumBytes": 5_000_000,
    "decodedRgbaBytes": EXPECTED_DECODED_RGBA_BYTES,
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_module(name: str, path: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Cannot load Python module at {path}.")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def read_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"{label} must contain a JSON object.")
    return value


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def percentile(np, values: list[float], q: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), q))


def summarize(np, values: list[float]) -> dict[str, float]:
    array = np.asarray(values, dtype=np.float64)
    return {
        "median": round(float(np.median(array)), 6),
        "p95": round(percentile(np, values, 95), 6),
        "maximum": round(float(np.max(array)), 6),
    }


def atlas_cells(np, image, grid_size: int, tile_size: int):
    expected = grid_size * tile_size
    if image.shape != (expected, expected, 4):
        raise RuntimeError(
            f"Atlas decoded to {image.shape}; expected {expected} x {expected} RGBA."
        )
    return [
        [
            image[
                row * tile_size : (row + 1) * tile_size,
                column * tile_size : (column + 1) * tile_size,
            ].copy()
            for column in range(grid_size)
        ]
        for row in range(grid_size)
    ]


def expected_controls(multi, source_controls):
    return [
        [
            sum(
                source_controls[source_row][source_column] * weight
                for source_row, source_column, weight in multi.neighboring_weights(
                    column, row, DENSE_GRID_SIZE, SOURCE_GRID_SIZE
                )
            )
            for column in range(DENSE_GRID_SIZE)
        ]
        for row in range(DENSE_GRID_SIZE)
    ]


def observed_topology(helper, np, controls, triangles, neutral_controls):
    neutral_areas = helper.signed_triangle_areas(neutral_controls, triangles)
    minimum = math.inf
    folds = 0
    for row in controls:
        for points in row:
            areas = helper.signed_triangle_areas(points, triangles)
            folds += int(np.count_nonzero(areas * neutral_areas <= 1e-5))
            minimum = min(minimum, float(np.min(np.abs(areas))) * 0.5)
    return folds, minimum


def continuity_residuals(np, observed, expected):
    axial: list[float] = []
    diagonal: list[float] = []
    size = len(observed)

    def append(target: list[float], first, second, expected_first, expected_second):
        actual_delta = second - first
        expected_delta = expected_second - expected_first
        target.append(float(np.sqrt(np.mean((actual_delta - expected_delta) ** 2))))

    for row in range(size):
        for column in range(size - 1):
            append(
                axial,
                observed[row][column],
                observed[row][column + 1],
                expected[row][column],
                expected[row][column + 1],
            )
    for column in range(size):
        for row in range(size - 1):
            append(
                axial,
                observed[row][column],
                observed[row + 1][column],
                expected[row][column],
                expected[row + 1][column],
            )
    for row in range(size - 1):
        for column in range(size - 1):
            append(
                diagonal,
                observed[row][column],
                observed[row + 1][column + 1],
                expected[row][column],
                expected[row + 1][column + 1],
            )
            append(
                diagonal,
                observed[row][column + 1],
                observed[row + 1][column],
                expected[row][column + 1],
                expected[row + 1][column],
            )
    return axial, diagonal


def psnr(np, reference, candidate, mask) -> float:
    differences = (reference.astype(np.float64) - candidate.astype(np.float64)) ** 2
    samples = differences[mask]
    mse = float(np.mean(samples)) if samples.size else math.inf
    return math.inf if mse == 0 else 10.0 * math.log10((255.0**2) / mse)


def anchor_preservation(helper, np, source, dense):
    records: list[dict[str, Any]] = []
    for source_row, dense_row in enumerate(ANCHOR_OUTPUT_INDICES):
        for source_column, dense_column in enumerate(ANCHOR_OUTPUT_INDICES):
            resized_premultiplied = helper.resize_cell(
                source[source_row][source_column], TILE_SIZE
            )
            reference = helper.unpremultiply(resized_premultiplied)
            candidate = dense[dense_row][dense_column]
            alpha_error = int(
                np.max(
                    np.abs(
                        reference[:, :, 3].astype(np.int16)
                        - candidate[:, :, 3].astype(np.int16)
                    )
                )
            )
            foreground = np.repeat(reference[:, :, 3:4] >= 8, 3, axis=2)
            foreground_rgb_psnr = psnr(
                np, reference[:, :, :3], candidate[:, :, :3], foreground
            )
            foreground_rgb_mae = float(
                np.mean(
                    np.abs(
                        reference[:, :, :3].astype(np.float64)
                        - candidate[:, :, :3].astype(np.float64)
                    )[foreground]
                )
            )
            records.append(
                {
                    "sourceRow": source_row,
                    "sourceColumn": source_column,
                    "valence": round(-1.0 + 2.0 * source_column / 4.0, 2),
                    "arousal": round(1.0 - 2.0 * source_row / 4.0, 2),
                    "denseRow": dense_row,
                    "denseColumn": dense_column,
                    "maximumAlphaError": alpha_error,
                    "foregroundRgbPsnrDb": round(foreground_rgb_psnr, 6),
                    "foregroundRgbMeanAbsoluteError": round(foreground_rgb_mae, 6),
                }
            )
    return records


def segment_progress(np, nodes):
    start = nodes[0].reshape(-1).astype(np.float64)
    end = nodes[-1].reshape(-1).astype(np.float64)
    direction = end - start
    denominator = float(np.dot(direction, direction))
    if denominator <= 1e-8:
        return None
    return [
        float(np.dot(node.reshape(-1) - start, direction) / denominator)
        for node in nodes
    ]


def axis_progress_diagnostic(np, observed):
    series: list[tuple[str, int, str, list[float]]] = []
    size = len(observed)
    center = size // 2
    for row in range(size):
        for segment, nodes in (
            ("negative-to-neutral", observed[row][0 : center + 1]),
            ("neutral-to-positive", observed[row][center:size]),
        ):
            progress = segment_progress(np, nodes)
            if progress is not None:
                series.append(("valence", row, segment, progress))
    for column in range(size):
        column_nodes = [observed[row][column] for row in range(size)]
        for segment, nodes in (
            ("positive-to-neutral", column_nodes[0 : center + 1]),
            ("neutral-to-negative", column_nodes[center:size]),
        ):
            progress = segment_progress(np, nodes)
            if progress is not None:
                series.append(("arousal", column, segment, progress))

    increments: list[float] = []
    linear_errors: list[float] = []
    reversals: list[dict[str, Any]] = []
    near_stalls: list[dict[str, Any]] = []
    for axis, fixed_index, segment, progress in series:
        ideal_increment = 1.0 / (len(progress) - 1)
        expected = [index * ideal_increment for index in range(len(progress))]
        linear_errors.extend(abs(actual - ideal) for actual, ideal in zip(progress, expected))
        for index, (first, second) in enumerate(zip(progress, progress[1:])):
            increment = second - first
            increments.append(increment)
            record = {
                "axis": axis,
                "fixedIndex": fixed_index,
                "segment": segment,
                "step": index,
                "increment": round(increment, 6),
            }
            if increment < 0:
                reversals.append(record)
            elif increment < ideal_increment * 0.5:
                near_stalls.append(record)
    return {
        "diagnosticOnly": True,
        "seriesCount": len(series),
        "minimumIncrement": round(min(increments), 6) if increments else None,
        "maximumLinearError": round(max(linear_errors), 6) if linear_errors else None,
        "reversalCount": len(reversals),
        "nearStallCount": len(near_stalls),
        "reversals": reversals,
        "nearStalls": near_stalls,
        "interpretation": (
            "Endpoint-projected landmark motion is a noisy engineering diagnostic. "
            "It is deliberately excluded from pass/fail and is not perceived-VA evidence."
        ),
    }


def contains_participant_payload(value: Any) -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = "".join(character for character in key.lower() if character.isalnum())
            if normalized in {"participantmediaused", "participantannotationsused"}:
                if child is not False:
                    return True
                continue
            if any(
                token in normalized
                for token in (
                    "participantidentifier",
                    "participantid",
                    "participantmedia",
                    "participantannotation",
                    "trialrow",
                )
            ) and child not in (None, False, "", [], {}):
                return True
            if contains_participant_payload(child):
                return True
    elif isinstance(value, list):
        return any(contains_participant_payload(child) for child in value)
    return False


def safe_referenced_path(pack_directory: Path, relative: str, asset_root: Path) -> Path:
    candidate = (pack_directory / relative).resolve()
    candidate.relative_to(asset_root.resolve())
    return candidate


def verify(args: argparse.Namespace) -> dict[str, Any]:
    pack_directory = args.pack_directory.resolve()
    asset_root = pack_directory.parents[1]
    source_path = pack_directory / "anchors-v1.png"
    authoring_path = pack_directory / "authoring-v1.json"
    atlas_path = pack_directory / "atlas-v1.webp"
    metadata_path = pack_directory / "atlas-v1.json"
    builder_path = args.builder.resolve()
    helper_path = args.geometry_helper.resolve()
    verifier_path = Path(__file__).resolve()

    for path in (
        source_path,
        authoring_path,
        atlas_path,
        metadata_path,
        builder_path,
        helper_path,
    ):
        if not path.is_file():
            raise FileNotFoundError(path)

    metadata = read_object(metadata_path, "metadata")
    authoring = read_object(authoring_path, "authoring record")
    multi = load_module("affect_tracker_multi_anchor_builder", builder_path)
    helper = load_module("affect_tracker_legacy_geometry", helper_path)
    np = helper.np

    source_hash = sha256(source_path)
    authoring_hash = sha256(authoring_path)
    atlas_hash = sha256(atlas_path)
    builder_hash = sha256(builder_path)
    helper_hash = sha256(helper_path)
    metadata_hash = sha256(metadata_path)
    verifier_hash = sha256(verifier_path)

    generated_sheet = authoring.get("generatedAnchorSheet", {})
    source_reference = authoring.get("sourceReference", {})
    reference_path = safe_referenced_path(
        pack_directory, str(source_reference.get("path", "")), asset_root
    )
    if not reference_path.is_file():
        raise FileNotFoundError(reference_path)
    reference_hash = sha256(reference_path)

    preprocessing_metadata = metadata.get("sourcePreprocessing", {})
    with tempfile.TemporaryDirectory(
        prefix=f".{PACK_ID}-qa-", dir=pack_directory
    ) as temporary_name:
        prepared_path = Path(temporary_name) / "prepared-anchors.png"
        reproduced_preprocessing = multi.prepare_source(
            source_path,
            prepared_path,
            SOURCE_GRID_SIZE,
            helper,
            int(preprocessing_metadata.get("blackPoint", -1)),
            int(preprocessing_metadata.get("opaquePoint", -1)),
        )
        prepared_hash = sha256(prepared_path)
        prepared_image = np.array(helper.Image.open(prepared_path).convert("RGBA"))
        source = multi.source_cells(prepared_image, SOURCE_GRID_SIZE)

    source_landmarks = helper.detect_landmarks(source)
    detected_source_face_count = sum(len(row) for row in source_landmarks)
    center = SOURCE_GRID_SIZE // 2
    indices = helper.control_indices(source_landmarks[center][center])
    boundary = helper.boundary_points(TILE_SIZE)
    source_size = source[0][0].shape[0]
    source_controls = [
        [
            helper.scaled_controls(points, indices, source_size, TILE_SIZE, boundary)
            for points in row
        ]
        for row in source_landmarks
    ]
    triangles = helper.Delaunay(source_controls[center][center]).simplices.astype(np.int32)
    expected_topology_minimum = multi.validate_topology(
        source_controls, triangles, helper, SOURCE_GRID_SIZE
    )
    expected = expected_controls(multi, source_controls)

    atlas_image = np.array(helper.Image.open(atlas_path).convert("RGBA"))
    dense = atlas_cells(np, atlas_image, DENSE_GRID_SIZE, TILE_SIZE)
    dense_landmarks = helper.detect_landmarks(dense)
    detected_dense_face_count = sum(len(row) for row in dense_landmarks)
    observed_landmarks = [
        [points[indices].astype(np.float32) for points in row]
        for row in dense_landmarks
    ]
    expected_landmarks = [
        [points[: len(indices)] for points in row]
        for row in expected
    ]
    landmark_errors = [
        float(error)
        for row in range(DENSE_GRID_SIZE)
        for column in range(DENSE_GRID_SIZE)
        for error in np.linalg.norm(
            observed_landmarks[row][column] - expected_landmarks[row][column], axis=1
        )
    ]
    landmark_summary = summarize(np, landmark_errors)
    axial_continuity, diagonal_continuity = continuity_residuals(
        np, observed_landmarks, expected_landmarks
    )
    axial_summary = summarize(np, axial_continuity)
    diagonal_summary = summarize(np, diagonal_continuity)
    observed_controls = [
        [np.concatenate([points, boundary], axis=0) for points in row]
        for row in observed_landmarks
    ]
    folds, observed_topology_minimum = observed_topology(
        helper,
        np,
        observed_controls,
        triangles,
        source_controls[center][center],
    )
    anchors = anchor_preservation(helper, np, source, dense)
    minimum_anchor_psnr = min(item["foregroundRgbPsnrDb"] for item in anchors)
    maximum_anchor_alpha_error = max(item["maximumAlphaError"] for item in anchors)

    actual_versions = {
        "mediapipe": helper.mp.__version__,
        "opencv": helper.cv2.__version__,
        "numpy": helper.np.__version__,
        "scipy": helper.scipy.__version__,
        "pillow": helper.PIL.__version__,
    }
    atlas_bytes = atlas_path.stat().st_size
    decoded_rgba_bytes = int(atlas_image.size * atlas_image.dtype.itemsize)
    affect_evidence = metadata.get("affectEvidence", {})
    authoring_evidence = authoring.get("affectEvidence", {})
    tooling = metadata.get("tooling", {})
    provenance = metadata.get("provenance", {})

    checks = {
        "metadataSchemaVersionAndPackAreExact": (
            metadata.get("schema") == METADATA_SCHEMA
            and metadata.get("version") == METADATA_VERSION
            and metadata.get("id") == PACK_ID
        ),
        "authoringSchemaVersionAndIdentityAreExact": (
            authoring.get("schema") == AUTHORING_SCHEMA
            and authoring.get("version") == AUTHORING_VERSION
            and authoring.get("classification")
            == "project-authored-synthetic-image-to-image-experiment"
        ),
        "sourceHashMatchesMetadataAndAuthoring": (
            metadata.get("source") == source_path.name
            and metadata.get("sourceSha256") == source_hash
            and generated_sheet.get("path") == source_path.name
            and generated_sheet.get("sha256") == source_hash
        ),
        "authoringHashMatchesMetadata": (
            metadata.get("authoring") == authoring_path.name
            and metadata.get("authoringSha256") == authoring_hash
        ),
        "atlasHashMatchesMetadata": (
            metadata.get("output") == atlas_path.name
            and metadata.get("outputSha256") == atlas_hash
        ),
        "builderHashMatchesMetadata": (
            tooling.get("builder") == builder_path.name
            and tooling.get("builderSha256") == builder_hash
        ),
        "geometryHelperHashMatchesMetadata": (
            tooling.get("geometryHelper") == helper_path.name
            and tooling.get("geometryHelperSha256") == helper_hash
        ),
        "toolVersionsMatchMetadata": metadata.get("versions") == actual_versions,
        "sourcePreprocessingReproducesExactly": (
            metadata.get("preparedSourceSha256") == prepared_hash
            and preprocessing_metadata == reproduced_preprocessing
        ),
        "sourceGridHasExactlyTwentyFiveDetectedFaces": (
            metadata.get("sourceGridSize") == SOURCE_GRID_SIZE
            and metadata.get("sourceAnchorCount") == SOURCE_ANCHOR_COUNT
            and generated_sheet.get("sourceGridSize") == SOURCE_GRID_SIZE
            and generated_sheet.get("sourceAnchorCount") == SOURCE_ANCHOR_COUNT
            and detected_source_face_count == SOURCE_ANCHOR_COUNT
            and all(len(row) == SOURCE_GRID_SIZE for row in source_landmarks)
        ),
        "anchorLineageDistinguishesGeneratedAndReferencePositions": (
            metadata.get("additionalIntermediateAnchorCount")
            == ADDITIONAL_GRID_POSITION_COUNT
            and generated_sheet.get("additionalIntermediateAnchorCount")
            == ADDITIONAL_GRID_POSITION_COUNT
            and source_reference.get("sha256") == reference_hash
            and source_reference.get("identityType") == "synthetic-fictional"
            and source_reference.get("sourceOwnership") == "project-owned"
            and reference_path != source_path
        ),
        "denseAtlasHasExactlyFourHundredFortyOneDetectedFaces": (
            metadata.get("gridSize") == DENSE_GRID_SIZE
            and metadata.get("nodeCount") == DENSE_NODE_COUNT
            and metadata.get("tileSize") == TILE_SIZE
            and detected_dense_face_count == DENSE_NODE_COUNT
            and all(len(row) == DENSE_GRID_SIZE for row in dense_landmarks)
        ),
        "allTwentyFiveAnchorsLandOnExactOutputNodes": (
            (DENSE_GRID_SIZE - 1) % (SOURCE_GRID_SIZE - 1) == 0
            and ANCHOR_OUTPUT_INDICES
            == [
                index * (DENSE_GRID_SIZE - 1) // (SOURCE_GRID_SIZE - 1)
                for index in range(SOURCE_GRID_SIZE)
            ]
            and len(anchors) == SOURCE_ANCHOR_COUNT
            and {(item["denseRow"], item["denseColumn"]) for item in anchors}
            == {
                (row, column)
                for row in ANCHOR_OUTPUT_INDICES
                for column in ANCHOR_OUTPUT_INDICES
            }
        ),
        "anchorsPreserveAlphaWithinEncoderTolerance": (
            maximum_anchor_alpha_error <= THRESHOLDS["anchorMaximumAlphaError"]
        ),
        "anchorsPreserveRgbWithinEncoderTolerance": (
            minimum_anchor_psnr
            >= THRESHOLDS["anchorMinimumForegroundRgbPsnrDb"]
        ),
        "expectedTopologyHasNoFolds": expected_topology_minimum > 0,
        "observedLandmarkTopologyHasNoFolds": (
            folds == 0 and observed_topology_minimum > 0
        ),
        "landmarkAgreementWithinBounds": (
            landmark_summary["median"] <= THRESHOLDS["landmarkMedianErrorPixels"]
            and landmark_summary["p95"] <= THRESHOLDS["landmarkP95ErrorPixels"]
            and landmark_summary["maximum"]
            <= THRESHOLDS["landmarkMaximumErrorPixels"]
        ),
        "axialNeighborContinuityWithinBounds": (
            axial_summary["p95"]
            <= THRESHOLDS["neighborContinuityP95ResidualPixels"]
        ),
        "diagonalNeighborContinuityWithinBounds": (
            diagonal_summary["p95"]
            <= THRESHOLDS["diagonalContinuityP95ResidualPixels"]
        ),
        "atlasTransferAndDecodedMemoryStayWithinExistingRuntimeEnvelope": (
            atlas_bytes <= THRESHOLDS["atlasMaximumBytes"]
            and decoded_rgba_bytes == THRESHOLDS["decodedRgbaBytes"]
            and atlas_image.shape == (
                EXPECTED_ATLAS_PIXELS,
                EXPECTED_ATLAS_PIXELS,
                4,
            )
        ),
        "evidenceBoundaryIsNotWeakened": (
            metadata.get("affectValidation") == multi.AFFECT_VALIDATION_BOUNDARY
            and provenance.get("affectValidation") == multi.AFFECT_VALIDATION_BOUNDARY
            and "not independently validated affect observations"
            in multi.AFFECT_VALIDATION_BOUNDARY
        ),
        "noParticipantMediaAnnotationsOrRowsArePackaged": (
            affect_evidence.get("participantMediaUsed") is False
            and affect_evidence.get("participantAnnotationsUsed") is False
            and authoring_evidence.get("participantMediaUsed") is False
            and authoring_evidence.get("participantAnnotationsUsed") is False
            and not contains_participant_payload(metadata)
            and not contains_participant_payload(authoring)
        ),
    }

    report = {
        "schema": QA_SCHEMA,
        "version": QA_VERSION,
        "passed": all(checks.values()),
        "evidenceBoundary": EVIDENCE_BOUNDARY,
        "anchorLineage": {
            "generatedAnchorGridSize": SOURCE_GRID_SIZE,
            "generatedAnchorCount": SOURCE_ANCHOR_COUNT,
            "additionalGridPositionCount": ADDITIONAL_GRID_POSITION_COUNT,
            "referenceGridSize": REFERENCE_GRID_SIZE,
            "referenceAnchorCount": REFERENCE_ANCHOR_COUNT,
            "referenceRole": REFERENCE_ROLE,
        },
        "thresholds": THRESHOLDS,
        "checks": checks,
        "diagnostics": {
            "gating": False,
            "sourceAnchorAxisProgress": axis_progress_diagnostic(
                np,
                [
                    [points[indices].astype(np.float32) for points in row]
                    for row in source_landmarks
                ],
            ),
            "denseObservedAxisProgress": axis_progress_diagnostic(
                np, observed_landmarks
            ),
            "boundary": (
                "These endpoint-projected landmark diagnostics are excluded from "
                "pass/fail and cannot establish perceived valence or arousal."
            ),
        },
        "asset": {
            "packId": PACK_ID,
            "source": source_path.name,
            "sourceSha256": source_hash,
            "preparedSourceSha256": prepared_hash,
            "authoring": authoring_path.name,
            "authoringSha256": authoring_hash,
            "referenceSource": reference_path.relative_to(asset_root).as_posix(),
            "referenceSourceSha256": reference_hash,
            "atlas": atlas_path.name,
            "atlasSha256": atlas_hash,
            "atlasBytes": atlas_bytes,
            "decodedRgbaBytes": decoded_rgba_bytes,
            "decodedRgbaMegabytes": round(decoded_rgba_bytes / 1_000_000, 4),
            "decodedRgbaMebibytes": round(decoded_rgba_bytes / (1024**2), 4),
            "metadata": metadata_path.name,
            "metadataSha256": metadata_hash,
            "builder": builder_path.name,
            "builderSha256": builder_hash,
            "geometryHelper": helper_path.name,
            "geometryHelperSha256": helper_hash,
            "verifier": verifier_path.name,
            "verifierSha256": verifier_hash,
            "sourceGridSize": SOURCE_GRID_SIZE,
            "sourceAnchorCount": SOURCE_ANCHOR_COUNT,
            "additionalGridPositionCount": ADDITIONAL_GRID_POSITION_COUNT,
            "gridSize": DENSE_GRID_SIZE,
            "nodeCount": DENSE_NODE_COUNT,
            "tileSize": TILE_SIZE,
            "detectedSourceFaceCount": detected_source_face_count,
            "detectedCellCount": detected_dense_face_count,
        },
        "toolVersions": actual_versions,
        "metrics": {
            "expectedTopologyMinimumTriangleAreaPixels": round(
                expected_topology_minimum, 6
            ),
            "observedTopologyMinimumTriangleAreaPixels": round(
                observed_topology_minimum, 6
            ),
            "observedFoldCount": folds,
            "landmarkErrorPixels": landmark_summary,
            "axialNeighborLandmarkDeltaResidualPixels": axial_summary,
            "diagonalNeighborLandmarkDeltaResidualPixels": diagonal_summary,
            "anchorPreservation": {
                "minimumForegroundRgbPsnrDb": minimum_anchor_psnr,
                "maximumAlphaError": maximum_anchor_alpha_error,
                "anchorOutputIndices": ANCHOR_OUTPUT_INDICES,
                "anchors": anchors,
            },
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pack-directory",
        type=Path,
        default=Path("site/assets/affect-face/packs") / PACK_ID,
    )
    parser.add_argument(
        "--builder",
        type=Path,
        default=Path("scripts/build-multi-anchor-photo-atlas.py"),
    )
    parser.add_argument(
        "--geometry-helper",
        type=Path,
        default=Path("scripts/build-dense-photo-atlas.py"),
    )
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    pack_directory = args.pack_directory.resolve()
    if pack_directory.name != PACK_ID:
        raise ValueError(f"This verifier is pinned to {PACK_ID} only.")
    report_path = (args.report or pack_directory / "atlas-v1-qa.json").resolve()
    report = verify(args)
    atomic_write_json(report_path, report)
    print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
