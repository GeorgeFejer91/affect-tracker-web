#!/usr/bin/env python3
"""Build a denser, identity-locked affect atlas from the nine owned anchors.

The source is a 3 x 3 RGBA WebP whose columns encode valence -1/0/+1 and
whose rows encode arousal +1/0/-1. MediaPipe is used only offline to locate
corresponding facial features. Each dense cell then:

1. bilinearly interpolates a target landmark mesh;
2. piecewise-affine warps the four neighboring owned source cells to it; and
3. combines the premultiplied pixels with the same bilinear weights.

This creates useful geometric in-between frames without inventing new affect
labels, running recognition in the app, or shipping a MediaPipe model.

The checked-in v2 asset was built with Python 3.11, mediapipe 0.10.8,
OpenCV 4.8.1, NumPy 1.26.4, SciPy 1.10.1, and Pillow 12.2.0.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import cv2
import mediapipe as mp
import numpy as np
import PIL
import scipy
from PIL import Image
from scipy.spatial import Delaunay


SOURCE_GRID_SIZE = 3
DEFAULT_GRID_SIZE = 11
DEFAULT_TILE_SIZE = 224
DEFAULT_QUALITY = 84

# This compact semantic subset retains the oval, brows, eyes, nose, and outer
# mouth while omitting the unstable inner-lip vertical pair 13/14. Delaunay on
# the neutral cell plus the 16 fixed boundary points produces 98 triangles.
# All nine anchors and a 101 x 101 bilinear sweep were verified to preserve the
# neutral triangle orientations before this set was adopted.
STABLE_LANDMARK_INDICES = [
    10, 234, 93, 58, 172, 152, 397, 288, 323, 454,
    70, 105, 107, 336, 334, 300,
    33, 159, 133, 145, 362, 386, 263, 374,
    168, 1, 2, 98, 327,
    61, 37, 0, 267, 291, 314, 17, 84, 78, 308, 87, 50, 280,
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_cells(image: np.ndarray) -> list[list[np.ndarray]]:
    height, width = image.shape[:2]
    if width % SOURCE_GRID_SIZE or height % SOURCE_GRID_SIZE:
        raise ValueError("The source atlas dimensions must be divisible by 3.")
    cell_width = width // SOURCE_GRID_SIZE
    cell_height = height // SOURCE_GRID_SIZE
    size = min(cell_width, cell_height)
    inset_x = (cell_width - size) // 2
    inset_y = (cell_height - size) // 2
    cells: list[list[np.ndarray]] = []
    for row in range(SOURCE_GRID_SIZE):
        row_cells = []
        for column in range(SOURCE_GRID_SIZE):
            left = column * cell_width + inset_x
            top = row * cell_height + inset_y
            row_cells.append(image[top : top + size, left : left + size].copy())
        cells.append(row_cells)
    return cells


def detect_landmarks(cells: list[list[np.ndarray]]) -> list[list[np.ndarray]]:
    results: list[list[np.ndarray]] = []
    with mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
    ) as detector:
        for row, row_cells in enumerate(cells):
            result_row = []
            for column, rgba in enumerate(row_cells):
                alpha = rgba[:, :, 3:4].astype(np.float32) / 255.0
                rgb = rgba[:, :, :3].astype(np.float32)
                detection_rgb = np.clip(rgb * alpha + 18.0 * (1.0 - alpha), 0, 255)
                detection = detector.process(detection_rgb.astype(np.uint8))
                if not detection.multi_face_landmarks:
                    raise RuntimeError(
                        f"MediaPipe found no face in source cell row={row}, column={column}."
                    )
                landmarks = detection.multi_face_landmarks[0].landmark
                height, width = rgba.shape[:2]
                points = np.array(
                    [[point.x * (width - 1), point.y * (height - 1)] for point in landmarks],
                    dtype=np.float32,
                )
                result_row.append(points)
            results.append(result_row)
    return results


def control_indices(neutral_points: np.ndarray) -> list[int]:
    if max(STABLE_LANDMARK_INDICES) >= len(neutral_points):
        raise RuntimeError("MediaPipe returned fewer landmarks than the stable mesh requires.")
    return STABLE_LANDMARK_INDICES.copy()


def boundary_points(size: int) -> np.ndarray:
    end = float(size - 1)
    quarter = end * 0.25
    half = end * 0.5
    values = [0.0, quarter, half, end - quarter, end]
    points = {(x, 0.0) for x in values}
    points.update((x, end) for x in values)
    points.update((0.0, y) for y in values[1:-1])
    points.update((end, y) for y in values[1:-1])
    return np.array(sorted(points), dtype=np.float32)


def resize_cell(cell: np.ndarray, tile_size: int) -> np.ndarray:
    interpolation = cv2.INTER_AREA if cell.shape[0] > tile_size else cv2.INTER_LANCZOS4
    resized = cv2.resize(cell, (tile_size, tile_size), interpolation=interpolation)
    straight = resized.astype(np.float32) / 255.0
    alpha = straight[:, :, 3:4]
    straight[:, :, :3] *= alpha
    return straight


def scaled_controls(
    points: np.ndarray,
    indices: list[int],
    source_size: int,
    tile_size: int,
    boundary: np.ndarray,
) -> np.ndarray:
    scale = (tile_size - 1) / max(1, source_size - 1)
    selected = np.clip(points[indices] * scale, 0, tile_size - 1)
    return np.concatenate([selected.astype(np.float32), boundary], axis=0)


def triangle_area(points: np.ndarray) -> float:
    a, b, c = points
    return abs(float(np.cross(b - a, c - a))) * 0.5


def signed_triangle_areas(points: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    first = points[triangles[:, 0]]
    second = points[triangles[:, 1]]
    third = points[triangles[:, 2]]
    edges_a = second - first
    edges_b = third - first
    return edges_a[:, 0] * edges_b[:, 1] - edges_a[:, 1] * edges_b[:, 0]


def validate_topology(
    controls: list[list[np.ndarray]],
    triangles: np.ndarray,
    sweep_size: int = 101,
) -> float:
    neutral_areas = signed_triangle_areas(controls[1][1], triangles)
    if np.any(np.abs(neutral_areas) <= 1e-5):
        raise RuntimeError("The neutral landmark mesh contains a degenerate triangle.")
    minimum_area = float(np.min(np.abs(neutral_areas))) * 0.5

    def inspect(points: np.ndarray, label: str) -> None:
        nonlocal minimum_area
        areas = signed_triangle_areas(points, triangles)
        if np.any(areas * neutral_areas <= 1e-5):
            raise RuntimeError(f"The landmark mesh folds or degenerates at {label}.")
        minimum_area = min(minimum_area, float(np.min(np.abs(areas))) * 0.5)

    for row in range(SOURCE_GRID_SIZE):
        for column in range(SOURCE_GRID_SIZE):
            inspect(controls[row][column], f"source row={row}, column={column}")
    for row in range(sweep_size):
        for column in range(sweep_size):
            weights = neighboring_weights(column, row, sweep_size)
            target = sum(controls[r][c] * weight for r, c, weight in weights)
            inspect(target, f"sweep row={row}, column={column}")
    return minimum_area


def warp_triangle(
    source: np.ndarray,
    destination: np.ndarray,
    source_triangle: np.ndarray,
    destination_triangle: np.ndarray,
) -> None:
    if triangle_area(source_triangle) < 0.05 or triangle_area(destination_triangle) < 0.05:
        return
    source_rect = cv2.boundingRect(source_triangle.astype(np.float32))
    destination_rect = cv2.boundingRect(destination_triangle.astype(np.float32))
    sx, sy, sw, sh = source_rect
    dx, dy, dw, dh = destination_rect
    if sw <= 0 or sh <= 0 or dw <= 0 or dh <= 0:
        return

    source_height, source_width = source.shape[:2]
    destination_height, destination_width = destination.shape[:2]
    sx0, sy0 = max(0, sx), max(0, sy)
    sx1, sy1 = min(source_width, sx + sw), min(source_height, sy + sh)
    dx0, dy0 = max(0, dx), max(0, dy)
    dx1, dy1 = min(destination_width, dx + dw), min(destination_height, dy + dh)
    if sx1 <= sx0 or sy1 <= sy0 or dx1 <= dx0 or dy1 <= dy0:
        return

    source_local = source_triangle - np.array([sx, sy], dtype=np.float32)
    destination_local = destination_triangle - np.array([dx, dy], dtype=np.float32)
    patch = source[sy0:sy1, sx0:sx1]
    if patch.size == 0:
        return
    if sx0 != sx or sy0 != sy:
        source_local -= np.array([sx0 - sx, sy0 - sy], dtype=np.float32)

    matrix = cv2.getAffineTransform(source_local.astype(np.float32), destination_local.astype(np.float32))
    warped = cv2.warpAffine(
        patch,
        matrix,
        (dw, dh),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    mask = np.zeros((dh, dw), dtype=np.float32)
    cv2.fillConvexPoly(mask, np.int32(np.round(destination_local)), 1.0, lineType=cv2.LINE_AA)

    crop_x0, crop_y0 = dx0 - dx, dy0 - dy
    crop_x1, crop_y1 = crop_x0 + (dx1 - dx0), crop_y0 + (dy1 - dy0)
    warped = warped[crop_y0:crop_y1, crop_x0:crop_x1]
    mask = mask[crop_y0:crop_y1, crop_x0:crop_x1, None]
    target = destination[dy0:dy1, dx0:dx1]
    destination[dy0:dy1, dx0:dx1] = target * (1.0 - mask) + warped * mask


def warp_mesh(
    source: np.ndarray,
    source_points: np.ndarray,
    target_points: np.ndarray,
    triangles: np.ndarray,
) -> np.ndarray:
    destination = np.zeros_like(source, dtype=np.float32)
    for triangle in triangles:
        warp_triangle(source, destination, source_points[triangle], target_points[triangle])
    return destination


def axis_blend(value: float) -> list[tuple[int, float]]:
    position = max(0.0, min(2.0, value))
    first = int(math.floor(position))
    second = int(math.ceil(position))
    if first == second:
        return [(first, 1.0)]
    mix = position - first
    return [(first, 1.0 - mix), (second, mix)]


def neighboring_weights(column: int, row: int, grid_size: int) -> list[tuple[int, int, float]]:
    x = -1.0 + 2.0 * column / (grid_size - 1)
    y = 1.0 - 2.0 * row / (grid_size - 1)
    columns = axis_blend(x + 1.0)
    rows = axis_blend(1.0 - y)
    return [
        (source_row, source_column, row_weight * column_weight)
        for source_row, row_weight in rows
        for source_column, column_weight in columns
        if row_weight * column_weight > 1e-8
    ]


def unpremultiply(premultiplied: np.ndarray) -> np.ndarray:
    alpha = np.clip(premultiplied[:, :, 3:4], 0.0, 1.0)
    rgb = np.zeros_like(premultiplied[:, :, :3])
    np.divide(
        premultiplied[:, :, :3],
        np.maximum(alpha, 1e-6),
        out=rgb,
        where=alpha > 1e-6,
    )
    straight = np.concatenate([np.clip(rgb, 0.0, 1.0), alpha], axis=2)
    return np.uint8(np.round(straight * 255.0))


def build_dense_atlas(
    input_path: Path,
    output_path: Path,
    metadata_path: Path,
    grid_size: int,
    tile_size: int,
    quality: int,
) -> None:
    source_image = np.array(Image.open(input_path).convert("RGBA"))
    cells = source_cells(source_image)
    landmarks = detect_landmarks(cells)
    indices = control_indices(landmarks[1][1])
    boundary = boundary_points(tile_size)
    source_size = cells[0][0].shape[0]
    resized_cells = [[resize_cell(cell, tile_size) for cell in row] for row in cells]
    controls = [
        [scaled_controls(points, indices, source_size, tile_size, boundary) for points in row]
        for row in landmarks
    ]
    neutral_controls = controls[1][1]
    triangles = Delaunay(neutral_controls).simplices.astype(np.int32)
    minimum_triangle_area = validate_topology(controls, triangles)

    atlas = np.zeros((grid_size * tile_size, grid_size * tile_size, 4), dtype=np.uint8)
    for row in range(grid_size):
        for column in range(grid_size):
            weights = neighboring_weights(column, row, grid_size)
            target_points = sum(controls[r][c] * weight for r, c, weight in weights)
            cell_output = np.zeros((tile_size, tile_size, 4), dtype=np.float32)
            for source_row, source_column, weight in weights:
                if weight >= 1.0 - 1e-8:
                    warped = resized_cells[source_row][source_column]
                else:
                    warped = warp_mesh(
                        resized_cells[source_row][source_column],
                        controls[source_row][source_column],
                        target_points,
                        triangles,
                    )
                cell_output += warped * weight
            y0, x0 = row * tile_size, column * tile_size
            atlas[y0 : y0 + tile_size, x0 : x0 + tile_size] = unpremultiply(cell_output)
        print(f"built dense atlas row {row + 1}/{grid_size}", flush=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(atlas, mode="RGBA").save(
        output_path,
        format="WEBP",
        quality=quality,
        method=6,
        exact=True,
    )
    metadata = {
        "id": "affect-face-atlas-v2-landmark-warp",
        "source": input_path.name,
        "sourceSha256": sha256(input_path),
        "output": output_path.name,
        "outputSha256": sha256(output_path),
        "sourceGridSize": SOURCE_GRID_SIZE,
        "gridSize": grid_size,
        "tileSize": tile_size,
        "quality": quality,
        "controlPointCount": int(len(neutral_controls)),
        "triangleCount": int(len(triangles)),
        "topologySweepSize": 101,
        "minimumTriangleAreaPixels": round(minimum_triangle_area, 6),
        "method": "MediaPipe stable semantic landmarks plus piecewise-affine premultiplied landmark warp",
        "versions": {
            "mediapipe": mp.__version__,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "pillow": PIL.__version__,
        },
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("site/assets/affect-face/affect-face-atlas-v1.webp"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("site/assets/affect-face/affect-face-atlas-v2.webp"),
    )
    parser.add_argument("--metadata", type=Path, default=None)
    parser.add_argument("--grid-size", type=int, default=DEFAULT_GRID_SIZE)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.grid_size < 3 or args.grid_size % 2 == 0:
        raise ValueError("--grid-size must be an odd integer of at least 3.")
    if not 96 <= args.tile_size <= 512:
        raise ValueError("--tile-size must be between 96 and 512 pixels.")
    if not 1 <= args.quality <= 100:
        raise ValueError("--quality must be between 1 and 100.")
    metadata_path = args.metadata or args.output.with_suffix(".json")
    build_dense_atlas(
        args.input.resolve(),
        args.output.resolve(),
        metadata_path.resolve(),
        args.grid_size,
        args.tile_size,
        args.quality,
    )


if __name__ == "__main__":
    main()
