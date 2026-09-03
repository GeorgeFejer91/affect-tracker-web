#!/usr/bin/env python3
"""Reproduce engineering QA for the checked-in dense photo atlas.

This verifies asset identity, warp topology, detected-landmark agreement,
neighbor continuity, preservation of the nine owned anchors, and monotonic
progress along each anchor-to-anchor geometry segment. These are rendering
and generation checks only; they do not validate perceived valence/arousal.

Run with the same pinned Python environment as build-dense-photo-atlas.py:

    python scripts/verify-dense-photo-atlas.py --report path/to/report.json

Pass ``--html path/to/contact-sheet.html`` for an offline visual-review grid.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import math
import shutil
import sys
from pathlib import Path


EVIDENCE_BOUNDARY = (
    "Engineering QA of deterministic image generation only; landmark and "
    "geometry proxies do not establish perceived or validated valence/arousal."
)

THRESHOLDS = {
    "anchorMinimumRgbPsnrDb": 35.0,
    "anchorMaximumAlphaError": 0,
    "landmarkMedianErrorPixels": 1.0,
    "landmarkP95ErrorPixels": 1.5,
    "landmarkMaximumErrorPixels": 3.0,
    "continuityP95ResidualPixels": 1.5,
    # Ideal generated-node progress is 0.1. These tolerances allow detector
    # noise while still rejecting a reversal, near-stall, or large excursion.
    "axisProgressMinimumIncrement": 0.05,
    "axisProgressMaximumLinearError": 0.15,
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def load_builder(path: Path):
    specification = importlib.util.spec_from_file_location("affect_atlas_builder", path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Cannot load atlas builder at {path}.")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def percentile(np, values, q: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), q))


def summarize(np, values) -> dict[str, float]:
    array = np.asarray(values, dtype=np.float64)
    return {
        "median": round(float(np.median(array)), 6),
        "p95": round(percentile(np, array, 95), 6),
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


def expected_controls(builder, source_controls, grid_size: int):
    return [
        [
            sum(
                source_controls[source_row][source_column] * weight
                for source_row, source_column, weight in builder.neighboring_weights(
                    column, row, grid_size
                )
            )
            for column in range(grid_size)
        ]
        for row in range(grid_size)
    ]


def observed_topology(builder, np, controls, triangles, neutral_controls):
    neutral_areas = builder.signed_triangle_areas(neutral_controls, triangles)
    minimum = math.inf
    folds = 0
    for row in controls:
        for points in row:
            areas = builder.signed_triangle_areas(points, triangles)
            folds += int(np.count_nonzero(areas * neutral_areas <= 1e-5))
            minimum = min(minimum, float(np.min(np.abs(areas))) * 0.5)
    return folds, minimum


def continuity_residuals(np, observed, expected):
    residuals = []
    rows = len(observed)
    columns = len(observed[0])
    for row in range(rows):
        for column in range(columns - 1):
            actual = observed[row][column + 1] - observed[row][column]
            target = expected[row][column + 1] - expected[row][column]
            residuals.append(float(np.sqrt(np.mean((actual - target) ** 2))))
    for column in range(columns):
        for row in range(rows - 1):
            actual = observed[row + 1][column] - observed[row][column]
            target = expected[row + 1][column] - expected[row][column]
            residuals.append(float(np.sqrt(np.mean((actual - target) ** 2))))
    return residuals


def segment_progress(np, nodes):
    start = nodes[0].reshape(-1).astype(np.float64)
    end = nodes[-1].reshape(-1).astype(np.float64)
    direction = end - start
    denominator = float(np.dot(direction, direction))
    if denominator <= 1e-8:
        raise RuntimeError("An axis proxy segment has no geometric displacement.")
    return [
        float(np.dot(node.reshape(-1) - start, direction) / denominator)
        for node in nodes
    ]


def axis_progress(np, observed):
    series = []
    size = len(observed)
    center = size // 2
    for row in range(size):
        series.append(("valence", row, "negative-to-neutral", segment_progress(
            np, observed[row][0 : center + 1]
        )))
        series.append(("valence", row, "neutral-to-positive", segment_progress(
            np, observed[row][center:size]
        )))
    for column in range(size):
        column_nodes = [observed[row][column] for row in range(size)]
        series.append(("arousal", column, "positive-to-neutral", segment_progress(
            np, column_nodes[0 : center + 1]
        )))
        series.append(("arousal", column, "neutral-to-negative", segment_progress(
            np, column_nodes[center:size]
        )))

    increments = []
    linear_errors = []
    violations = []
    for axis, fixed_index, segment, progress in series:
        expected = [index / (len(progress) - 1) for index in range(len(progress))]
        increments.extend(b - a for a, b in zip(progress, progress[1:]))
        linear_errors.extend(abs(a - b) for a, b in zip(progress, expected))
        for index, (a, b) in enumerate(zip(progress, progress[1:])):
            if b - a < THRESHOLDS["axisProgressMinimumIncrement"]:
                violations.append({
                    "axis": axis,
                    "fixedIndex": fixed_index,
                    "segment": segment,
                    "step": index,
                    "increment": round(b - a, 6),
                })
    return {
        "seriesCount": len(series),
        "minimumIncrement": round(min(increments), 6),
        "maximumLinearError": round(max(linear_errors), 6),
        "violationCount": len(violations),
        "violations": violations,
    }


def psnr(np, reference, candidate, mask) -> float:
    differences = (reference.astype(np.float64) - candidate.astype(np.float64)) ** 2
    samples = differences[mask]
    mse = float(np.mean(samples)) if samples.size else math.inf
    return math.inf if mse == 0 else 10.0 * math.log10((255.0**2) / mse)


def anchor_preservation(builder, np, source_cells, dense_cells, tile_size: int):
    records = []
    dense_step = (len(dense_cells) - 1) // 2
    for source_row in range(3):
        for source_column in range(3):
            dense_row = source_row * dense_step
            dense_column = source_column * dense_step
            premultiplied = builder.resize_cell(
                source_cells[source_row][source_column], tile_size
            )
            reference = builder.unpremultiply(premultiplied)
            candidate = dense_cells[dense_row][dense_column]
            alpha_error = int(np.max(np.abs(
                reference[:, :, 3].astype(np.int16) - candidate[:, :, 3].astype(np.int16)
            )))
            foreground = np.repeat(reference[:, :, 3:4] >= 8, 3, axis=2)
            rgb_psnr = psnr(np, reference[:, :, :3], candidate[:, :, :3], foreground)
            records.append({
                "sourceRow": source_row,
                "sourceColumn": source_column,
                "denseRow": dense_row,
                "denseColumn": dense_column,
                "maximumAlphaError": alpha_error,
                "foregroundRgbPsnrDb": round(rgb_psnr, 6),
            })
    return records


def make_html(path: Path, atlas_path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    copied_atlas = path.parent / "atlas.webp"
    if atlas_path.resolve() != copied_atlas.resolve():
        shutil.copyfile(atlas_path, copied_atlas)
    size = report["asset"]["gridSize"]
    tiles = []
    for row in range(size):
        y = 1.0 - 2.0 * row / (size - 1)
        for column in range(size):
            x = -1.0 + 2.0 * column / (size - 1)
            tiles.append(
                f'<figure><div class="tile" style="background-position:{column/(size-1)*100:.3f}% '
                f'{row/(size-1)*100:.3f}%"></div><figcaption>V {x:+.1f} · A {y:+.1f}</figcaption></figure>'
            )
    metrics = html.escape(json.dumps(report["metrics"], indent=2))
    document = f"""<!doctype html>
<meta charset="utf-8"><title>Dense Photoatlas Engineering QA</title>
<style>
body{{margin:24px;background:#111;color:#eee;font:14px system-ui,sans-serif}}
h1{{font-size:22px}} .boundary{{max-width:80ch;color:#ffc96b}}
.grid{{display:grid;grid-template-columns:repeat({size},minmax(72px,1fr));gap:8px;min-width:900px}}
figure{{margin:0}} .tile{{aspect-ratio:1;background:url('atlas.webp') no-repeat;background-size:{size*100}% {size*100}%;border:1px solid #444}}
figcaption{{font-size:10px;text-align:center;color:#bbb}} pre{{padding:16px;background:#1b1b1b;overflow:auto}}
</style><h1>Dense Photoatlas engineering contact sheet</h1>
<p class="boundary">{html.escape(EVIDENCE_BOUNDARY)}</p>
<p>Result: <strong>{'PASS' if report['passed'] else 'FAIL'}</strong></p>
<div class="grid">{''.join(tiles)}</div><h2>Metrics</h2><pre>{metrics}</pre>"""
    path.write_text(document, encoding="utf-8", newline="\n")


def verify(args: argparse.Namespace) -> dict:
    builder_path = args.builder.resolve()
    source_path = args.source.resolve()
    atlas_path = args.atlas.resolve()
    metadata_path = args.metadata.resolve()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    builder = load_builder(builder_path)
    np = builder.np

    identity_checks = {
        "sourceHashMatchesMetadata": digest(source_path) == metadata.get("sourceSha256"),
        "atlasHashMatchesMetadata": digest(atlas_path) == metadata.get("outputSha256"),
        "sourceFilenameMatchesMetadata": source_path.name == metadata.get("source"),
        "atlasFilenameMatchesMetadata": atlas_path.name == metadata.get("output"),
        "toolVersionsMatchMetadata": metadata.get("versions") == {
            "mediapipe": builder.mp.__version__,
            "opencv": builder.cv2.__version__,
            "numpy": builder.np.__version__,
            "scipy": builder.scipy.__version__,
            "pillow": builder.PIL.__version__,
        },
    }

    grid_size = int(metadata["gridSize"])
    tile_size = int(metadata["tileSize"])
    source_image = np.array(builder.Image.open(source_path).convert("RGBA"))
    atlas_image = np.array(builder.Image.open(atlas_path).convert("RGBA"))
    source = builder.source_cells(source_image)
    dense = atlas_cells(np, atlas_image, grid_size, tile_size)

    source_landmarks = builder.detect_landmarks(source)
    indices = builder.control_indices(source_landmarks[1][1])
    boundary = builder.boundary_points(tile_size)
    source_size = source[0][0].shape[0]
    source_controls = [
        [builder.scaled_controls(points, indices, source_size, tile_size, boundary) for points in row]
        for row in source_landmarks
    ]
    triangles = builder.Delaunay(source_controls[1][1]).simplices.astype(np.int32)
    topology_minimum = builder.validate_topology(source_controls, triangles)
    expected = expected_controls(builder, source_controls, grid_size)

    detected = builder.detect_landmarks(dense)
    observed_landmarks = [
        [points[indices].astype(np.float32) for points in row]
        for row in detected
    ]
    expected_landmarks = [
        [points[: len(indices)] for points in row]
        for row in expected
    ]
    errors = [
        float(value)
        for row in range(grid_size)
        for column in range(grid_size)
        for value in np.linalg.norm(
            observed_landmarks[row][column] - expected_landmarks[row][column], axis=1
        )
    ]
    continuity = continuity_residuals(np, observed_landmarks, expected_landmarks)
    observed_controls = [
        [np.concatenate([points, boundary], axis=0) for points in row]
        for row in observed_landmarks
    ]
    folds, observed_minimum = observed_topology(
        builder, np, observed_controls, triangles, source_controls[1][1]
    )
    anchors = anchor_preservation(builder, np, source, dense, tile_size)
    expected_progress = axis_progress(np, expected_landmarks)
    observed_progress = axis_progress(np, observed_landmarks)
    landmark_summary = summarize(np, errors)
    continuity_summary = summarize(np, continuity)

    checks = {
        **identity_checks,
        "gridIsOddAndCentered": grid_size >= 3 and grid_size % 2 == 1,
        "allDenseCellsDetected": all(len(row) == grid_size for row in detected),
        "expectedTopologyHasNoFolds": topology_minimum > 0,
        "observedLandmarkTopologyHasNoFolds": folds == 0 and observed_minimum > 0,
        "anchorsPreserveAlpha": max(item["maximumAlphaError"] for item in anchors)
        <= THRESHOLDS["anchorMaximumAlphaError"],
        "anchorsPreserveRgb": min(item["foregroundRgbPsnrDb"] for item in anchors)
        >= THRESHOLDS["anchorMinimumRgbPsnrDb"],
        "landmarkAgreementWithinBounds": (
            landmark_summary["median"] <= THRESHOLDS["landmarkMedianErrorPixels"]
            and landmark_summary["p95"] <= THRESHOLDS["landmarkP95ErrorPixels"]
            and landmark_summary["maximum"] <= THRESHOLDS["landmarkMaximumErrorPixels"]
        ),
        "neighborContinuityWithinBounds": continuity_summary["p95"]
        <= THRESHOLDS["continuityP95ResidualPixels"],
        "expectedAxisGeometryProgressIsMonotonic": (
            expected_progress["violationCount"] == 0
            and expected_progress["maximumLinearError"]
            <= THRESHOLDS["axisProgressMaximumLinearError"]
        ),
    }
    report = {
        "schema": "affect-tracker-photo-atlas-engineering-qa",
        "version": 1,
        "passed": all(checks.values()),
        "evidenceBoundary": EVIDENCE_BOUNDARY,
        "asset": {
            "source": source_path.name,
            "sourceSha256": digest(source_path),
            "atlas": atlas_path.name,
            "atlasSha256": digest(atlas_path),
            "metadata": metadata_path.name,
            "metadataSha256": digest(metadata_path),
            "builder": builder_path.name,
            "builderSha256": digest(builder_path),
            "verifier": Path(__file__).name,
            "verifierSha256": digest(Path(__file__).resolve()),
            "gridSize": grid_size,
            "tileSize": tile_size,
            "detectedCellCount": sum(len(row) for row in detected),
        },
        "toolVersions": metadata["versions"],
        "thresholds": THRESHOLDS,
        "checks": checks,
        "metrics": {
            "expectedTopologyMinimumTriangleAreaPixels": round(topology_minimum, 6),
            "observedTopologyMinimumTriangleAreaPixels": round(observed_minimum, 6),
            "observedFoldCount": folds,
            "landmarkErrorPixels": landmark_summary,
            "neighborLandmarkDeltaResidualPixels": continuity_summary,
            "expectedAxisAnchorPathProgress": expected_progress,
            "observedAxisAnchorPathProgress": observed_progress,
            "anchorPreservation": {
                "minimumForegroundRgbPsnrDb": min(
                    item["foregroundRgbPsnrDb"] for item in anchors
                ),
                "maximumAlphaError": max(item["maximumAlphaError"] for item in anchors),
                "anchors": anchors,
            },
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--builder", type=Path, default=Path("scripts/build-dense-photo-atlas.py"))
    parser.add_argument("--source", type=Path, default=Path("site/assets/affect-face/affect-face-atlas-v1.webp"))
    parser.add_argument("--atlas", type=Path, default=Path("site/assets/affect-face/affect-face-atlas-v3.webp"))
    parser.add_argument("--metadata", type=Path, default=Path("site/assets/affect-face/affect-face-atlas-v3.json"))
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--html", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = verify(args)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8", newline="\n")
    if args.html:
        make_html(args.html, args.atlas.resolve(), report)
    print(rendered, end="")
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
