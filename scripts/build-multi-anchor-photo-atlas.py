#!/usr/bin/env python3
"""Build a 21x21 Photoatlas from an odd, denser source-anchor grid.

This path is deliberately separate from ``build-dense-photo-atlas.py`` so the
locked nine-anchor v3 assets stay byte-for-byte reproducible.  It reuses only
that builder's tested MediaPipe landmark selection and piecewise-affine warp
primitives, while generalizing source interpolation from 3x3 to an arbitrary
odd grid.  The first checked-in consumer is a project-owned 5x5 image-to-image
anchor sheet: 25 authored frames, including 16 new intermediate keyframes.

MediaPipe runs during asset preparation only.  The browser receives one local
WebP atlas and performs no camera access, inference, or network model load.
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


DEFAULT_ASSET_ROOT = Path("site/assets/affect-face")
DEFAULT_PACK_ID = "photo-synthetic-08"
DEFAULT_SOURCE_GRID_SIZE = 5
DEFAULT_GRID_SIZE = 21
DEFAULT_TILE_SIZE = 160
DEFAULT_QUALITY = 88
DEFAULT_HELPER = Path("scripts/build-dense-photo-atlas.py")
METADATA_SCHEMA = "affect-tracker-photo-atlas-multi-anchor-pack"
METADATA_VERSION = 1
AFFECT_VALIDATION_BOUNDARY = (
    "Twenty-five project-owned image-to-image anchors and 441 derived nodes "
    "are presentation assets; they are not independently validated affect "
    "observations, emotion recognition, demographic inference, or diagnosis."
)
DEMOGRAPHIC_LABEL_SCOPE = (
    "Creator-selected appearance styling only; not a claim or inference of "
    "sex, gender identity, pronouns, race, ethnicity, ancestry, nationality, "
    "culture, or personal identity."
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_helper(path: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(
        "affect_tracker_legacy_atlas_geometry", path
    )
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Cannot load atlas geometry helper at {path}.")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
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


def source_cells(image, source_grid_size: int):
    height, width = image.shape[:2]
    if width != height or width % source_grid_size:
        raise ValueError(
            "The normalized source must be square and divisible by its source grid."
        )
    size = width // source_grid_size
    return [
        [
            image[
                row * size : (row + 1) * size,
                column * size : (column + 1) * size,
            ].copy()
            for column in range(source_grid_size)
        ]
        for row in range(source_grid_size)
    ]


def _connected_black_matte(cell_rgb, helper, black_point: int, opaque_point: int):
    np = helper.np
    cv2 = helper.cv2
    intensity = np.max(cell_rgb, axis=2)
    candidates = (intensity < opaque_point).astype(np.uint8)
    _count, labels = cv2.connectedComponents(candidates, connectivity=8)
    border_labels = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border_labels = border_labels[border_labels != 0]
    connected = np.isin(labels, border_labels)
    scale = max(1, opaque_point - black_point)
    transition = np.clip(
        (intensity.astype(np.float32) - black_point) / scale, 0.0, 1.0
    )
    transition = transition * transition * (3.0 - 2.0 * transition)
    alpha = np.ones_like(transition, dtype=np.float32)
    alpha[connected] = transition[connected]
    straight_rgb = cell_rgb.astype(np.float32) / 255.0
    straight_rgb[alpha <= 1e-6] = 0.0
    rgba = np.concatenate([straight_rgb, alpha[:, :, None]], axis=2)
    return np.uint8(np.round(rgba * 255.0)), alpha


def prepare_source(
    input_path: Path,
    output_path: Path,
    source_grid_size: int,
    helper: ModuleType,
    black_point: int,
    opaque_point: int,
) -> dict[str, object]:
    image = helper.Image.open(input_path)
    input_mode = image.mode
    width, height = image.size
    normalized_size = min(width, height)
    normalized_size -= normalized_size % source_grid_size
    if normalized_size <= 0:
        raise ValueError("The source image is too small for the requested grid.")
    left = (width - normalized_size) // 2
    top = (height - normalized_size) // 2
    cropped = image.crop((left, top, left + normalized_size, top + normalized_size))
    np = helper.np

    if "A" in cropped.getbands():
        rgba = np.array(cropped.convert("RGBA"))
        alpha = rgba[:, :, 3].astype(np.float32) / 255.0
        method = "center-crop-preserve-alpha-v1"
    else:
        rgb = np.array(cropped.convert("RGB"))
        cell_size = normalized_size // source_grid_size
        rgba = np.zeros((normalized_size, normalized_size, 4), dtype=np.uint8)
        alpha = np.ones((normalized_size, normalized_size), dtype=np.float32)
        for row in range(source_grid_size):
            for column in range(source_grid_size):
                y0, y1 = row * cell_size, (row + 1) * cell_size
                x0, x1 = column * cell_size, (column + 1) * cell_size
                converted, converted_alpha = _connected_black_matte(
                    rgb[y0:y1, x0:x1], helper, black_point, opaque_point
                )
                rgba[y0:y1, x0:x1] = converted
                alpha[y0:y1, x0:x1] = converted_alpha
        method = "center-crop-cell-border-black-matte-soft-alpha-v1"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    helper.Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG")
    transparent = int(np.count_nonzero(alpha <= 1e-6))
    soft_mask = (alpha > 1e-6) & (alpha < 1.0 - 1e-6)
    soft = int(np.count_nonzero(soft_mask))
    return {
        "method": method,
        "inputMode": input_mode,
        "inputSize": [width, height],
        "normalizedSize": [normalized_size, normalized_size],
        "centerCrop": {"left": left, "top": top, "size": normalized_size},
        "sourceGridSize": source_grid_size,
        "cellSize": normalized_size // source_grid_size,
        "backgroundConnectivity": 8 if "A" not in cropped.getbands() else None,
        "blackPoint": black_point if "A" not in cropped.getbands() else None,
        "opaquePoint": opaque_point if "A" not in cropped.getbands() else None,
        "alphaCurve": "smoothstep" if "A" not in cropped.getbands() else None,
        "edgeRgbPolicy": (
            "preserve-source-straight-rgb" if "A" not in cropped.getbands() else None
        ),
        "transparentPixelCount": transparent,
        "softPixelCount": soft,
        "opaquePixelCount": int(alpha.size - transparent - soft),
        "preparedSha256": sha256(output_path),
        "limitation": (
            "Border-connected near-black foreground detail may be inseparable "
            "from the black matte and requires contact-sheet review."
            if "A" not in cropped.getbands()
            else "Source alpha is preserved after the recorded center crop."
        ),
    }


def axis_blend(position: float, source_grid_size: int):
    upper = float(source_grid_size - 1)
    clamped = max(0.0, min(upper, position))
    first = int(math.floor(clamped))
    second = int(math.ceil(clamped))
    if first == second:
        return [(first, 1.0)]
    mix = clamped - first
    return [(first, 1.0 - mix), (second, mix)]


def neighboring_weights(
    column: float,
    row: float,
    grid_size: int,
    source_grid_size: int = DEFAULT_SOURCE_GRID_SIZE,
):
    scale = (source_grid_size - 1) / (grid_size - 1)
    columns = axis_blend(column * scale, source_grid_size)
    rows = axis_blend(row * scale, source_grid_size)
    return [
        (source_row, source_column, row_weight * column_weight)
        for source_row, row_weight in rows
        for source_column, column_weight in columns
        if row_weight * column_weight > 1e-8
    ]


def validate_topology(
    controls,
    triangles,
    helper: ModuleType,
    source_grid_size: int,
    sweep_size: int = 101,
) -> float:
    np = helper.np
    center = source_grid_size // 2
    neutral_areas = helper.signed_triangle_areas(controls[center][center], triangles)
    if np.any(np.abs(neutral_areas) <= 1e-5):
        raise RuntimeError("The neutral landmark mesh contains a degenerate triangle.")
    minimum_area = float(np.min(np.abs(neutral_areas))) * 0.5

    def inspect(points, label: str) -> None:
        nonlocal minimum_area
        areas = helper.signed_triangle_areas(points, triangles)
        if np.any(areas * neutral_areas <= 1e-5):
            raise RuntimeError(f"The landmark mesh folds or degenerates at {label}.")
        minimum_area = min(minimum_area, float(np.min(np.abs(areas))) * 0.5)

    for row in range(source_grid_size):
        for column in range(source_grid_size):
            inspect(controls[row][column], f"source row={row}, column={column}")
    for row in range(sweep_size):
        for column in range(sweep_size):
            weights = neighboring_weights(
                column, row, sweep_size, source_grid_size
            )
            target = sum(controls[r][c] * weight for r, c, weight in weights)
            inspect(target, f"sweep row={row}, column={column}")
    return minimum_area


def build_atlas(args: argparse.Namespace) -> dict[str, object]:
    helper_path = args.helper.resolve()
    helper = load_helper(helper_path)
    input_path = args.input.resolve()
    output_path = args.output.resolve()
    metadata_path = args.metadata.resolve()
    authoring_path = args.authoring.resolve()
    if not input_path.is_file() or not authoring_path.is_file():
        raise FileNotFoundError("The source anchor sheet and authoring record are required.")
    if not args.force and (output_path.exists() or metadata_path.exists()):
        raise FileExistsError("Refusing to overwrite output; pass --force explicitly.")

    with tempfile.TemporaryDirectory(
        prefix=f".{args.pack_id}-multi-anchor-", dir=output_path.parent
    ) as temporary_name:
        temporary = Path(temporary_name)
        prepared_path = temporary / "prepared-anchors.png"
        preprocessing = prepare_source(
            input_path,
            prepared_path,
            args.source_grid_size,
            helper,
            args.matte_black_point,
            args.matte_opaque_point,
        )
        source_image = helper.np.array(helper.Image.open(prepared_path).convert("RGBA"))
        cells = source_cells(source_image, args.source_grid_size)
        landmarks = helper.detect_landmarks(cells)
        center = args.source_grid_size // 2
        indices = helper.control_indices(landmarks[center][center])
        boundary = helper.boundary_points(args.tile_size)
        source_size = cells[0][0].shape[0]
        resized_cells = [
            [helper.resize_cell(cell, args.tile_size) for cell in row] for row in cells
        ]
        controls = [
            [
                helper.scaled_controls(
                    points, indices, source_size, args.tile_size, boundary
                )
                for points in row
            ]
            for row in landmarks
        ]
        neutral_controls = controls[center][center]
        triangles = helper.Delaunay(neutral_controls).simplices.astype(helper.np.int32)
        minimum_triangle_area = validate_topology(
            controls, triangles, helper, args.source_grid_size
        )

        atlas = helper.np.zeros(
            (args.grid_size * args.tile_size, args.grid_size * args.tile_size, 4),
            dtype=helper.np.uint8,
        )
        for row in range(args.grid_size):
            for column in range(args.grid_size):
                weights = neighboring_weights(
                    column, row, args.grid_size, args.source_grid_size
                )
                target_points = sum(
                    controls[r][c] * weight for r, c, weight in weights
                )
                cell_output = helper.np.zeros(
                    (args.tile_size, args.tile_size, 4), dtype=helper.np.float32
                )
                for source_row, source_column, weight in weights:
                    if weight >= 1.0 - 1e-8:
                        warped = resized_cells[source_row][source_column]
                    else:
                        warped = helper.warp_mesh(
                            resized_cells[source_row][source_column],
                            controls[source_row][source_column],
                            target_points,
                            triangles,
                        )
                    cell_output += warped * weight
                y0, x0 = row * args.tile_size, column * args.tile_size
                atlas[y0 : y0 + args.tile_size, x0 : x0 + args.tile_size] = (
                    helper.unpremultiply(cell_output)
                )
            print(f"built multi-anchor atlas row {row + 1}/{args.grid_size}", flush=True)

        temporary_atlas = temporary / output_path.name
        helper.Image.fromarray(atlas, mode="RGBA").save(
            temporary_atlas,
            format="WEBP",
            quality=args.quality,
            method=6,
            exact=True,
        )
        versions = {
            "mediapipe": helper.mp.__version__,
            "opencv": helper.cv2.__version__,
            "numpy": helper.np.__version__,
            "scipy": helper.scipy.__version__,
            "pillow": helper.PIL.__version__,
        }
        metadata = {
            "schema": METADATA_SCHEMA,
            "version": METADATA_VERSION,
            "id": args.pack_id,
            "label": "Synthetic preset 09",
            "presentationStyle": "feminine-coded",
            "regionalDesignInspirations": [],
            "skinToneAudit": None,
            "source": input_path.name,
            "sourceSha256": sha256(input_path),
            "preparedSourceSha256": preprocessing["preparedSha256"],
            "sourcePreprocessing": preprocessing,
            "sourceGridSize": args.source_grid_size,
            "sourceAnchorCount": args.source_grid_size**2,
            "additionalIntermediateAnchorCount": args.source_grid_size**2 - 9,
            "authoring": authoring_path.name,
            "authoringSha256": sha256(authoring_path),
            "output": output_path.name,
            "outputSha256": sha256(temporary_atlas),
            "gridSize": args.grid_size,
            "nodeCount": args.grid_size**2,
            "tileSize": args.tile_size,
            "quality": args.quality,
            "controlPointCount": int(len(neutral_controls)),
            "triangleCount": int(len(triangles)),
            "topologySweepSize": 101,
            "minimumTriangleAreaPixels": round(minimum_triangle_area, 6),
            "method": (
                "25 project-owned image-to-image anchors plus MediaPipe stable "
                "landmarks and piecewise-affine premultiplied local interpolation"
            ),
            "runtimeInterpolation": (
                "continuous bilinear blend between adjacent 21x21 generated nodes"
            ),
            "affectEvidence": {
                "layoutSource": "https://www.nature.com/articles/s41598-023-49209-8",
                "layoutUse": "five valence by five arousal authoring design only",
                "participantMediaUsed": False,
                "participantAnnotationsUsed": False,
                "affecAggregateEvidence": "../../affec-perceived-va-evidence-v1.json",
            },
            "affectValidation": AFFECT_VALIDATION_BOUNDARY,
            "versions": versions,
            "tooling": {
                "builder": Path(__file__).name,
                "builderSha256": sha256(Path(__file__).resolve()),
                "geometryHelper": helper_path.name,
                "geometryHelperSha256": sha256(helper_path),
            },
            "provenance": {
                "identityType": "synthetic-fictional",
                "sourceOwnership": "project-owned",
                "demographicLabelType": "creator-prompt-inspiration-only",
                "demographicLabelScope": DEMOGRAPHIC_LABEL_SCOPE,
                "consentBasis": "synthetic-source-with-no-real-person-identity-intended",
                "license": "BSD-3-Clause",
                "generatorName": "OpenAI built-in image generation service",
                "generatorVersion": "service model version unavailable",
                "generatedOn": "2026-09-03",
                "generationRecord": authoring_path.name,
                "affectValidation": AFFECT_VALIDATION_BOUNDARY,
            },
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temporary_atlas, output_path)
        atomic_write_json(metadata_path, metadata)
    return metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    pack_directory = DEFAULT_ASSET_ROOT / "packs" / DEFAULT_PACK_ID
    parser.add_argument("--pack-id", default=DEFAULT_PACK_ID)
    parser.add_argument("--input", type=Path, default=pack_directory / "anchors-v1.png")
    parser.add_argument("--authoring", type=Path, default=pack_directory / "authoring-v1.json")
    parser.add_argument("--output", type=Path, default=pack_directory / "atlas-v1.webp")
    parser.add_argument("--metadata", type=Path, default=pack_directory / "atlas-v1.json")
    parser.add_argument("--helper", type=Path, default=DEFAULT_HELPER)
    parser.add_argument("--source-grid-size", type=int, default=DEFAULT_SOURCE_GRID_SIZE)
    parser.add_argument("--grid-size", type=int, default=DEFAULT_GRID_SIZE)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    parser.add_argument("--matte-black-point", type=int, default=8)
    parser.add_argument("--matte-opaque-point", type=int, default=24)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.pack_id != DEFAULT_PACK_ID:
        raise ValueError(f"This reproducible slice is pinned to {DEFAULT_PACK_ID}.")
    if args.source_grid_size < 3 or args.source_grid_size % 2 == 0:
        raise ValueError("--source-grid-size must be an odd integer of at least 3.")
    if args.grid_size < args.source_grid_size or args.grid_size % 2 == 0:
        raise ValueError("--grid-size must be odd and at least the source grid size.")
    if (args.grid_size - 1) % (args.source_grid_size - 1):
        raise ValueError("Every source anchor must land on an exact output node.")
    if not 96 <= args.tile_size <= 256:
        raise ValueError("--tile-size must be between 96 and 256 pixels.")
    if not 1 <= args.quality <= 100:
        raise ValueError("--quality must be between 1 and 100.")
    if not 0 <= args.matte_black_point < args.matte_opaque_point <= 255:
        raise ValueError("Matte thresholds must satisfy 0 <= black < opaque <= 255.")


def main() -> None:
    args = parse_args()
    validate_args(args)
    metadata = build_atlas(args)
    print(json.dumps(metadata, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
