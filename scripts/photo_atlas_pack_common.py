#!/usr/bin/env python3
"""Shared, deterministic helpers for separately packaged photo atlases."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import tempfile
from datetime import date
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any


CATALOG_SCHEMA = "affect-tracker-photo-atlas-catalog"
CATALOG_VERSION = 1
PACK_METADATA_SCHEMA = "affect-tracker-photo-atlas-pack"
PACK_METADATA_VERSION = 1
PACK_QA_SCHEMA = "affect-tracker-photo-atlas-pack-engineering-qa"
PACK_QA_VERSION = 1
SOURCE_GRID_SIZE = 3

PACK_ID_PATTERN = re.compile(r"photo-(?:reference-v3|synthetic-[0-9]{2})\Z")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
PRESENTATION_STYLES = frozenset(
    {"reference", "masculine-coded", "feminine-coded", "androgynous-styling"}
)
REGIONAL_DESIGN_INSPIRATIONS = frozenset(
    {
        "west-african",
        "african-diaspora",
        "east-asian",
        "south-asian",
        "west-asian",
        "north-african",
        "latin-american",
        "indigenous-americas",
        "pacific-islander",
        "polynesian",
    }
)

DEMOGRAPHIC_LABEL_SCOPE = (
    "Creator-selected appearance-prompt inspiration only; not a claim or "
    "inference of sex, gender identity, pronouns, race, ethnicity, ancestry, "
    "nationality, culture, or personal identity."
)
AFFECT_VALIDATION_BOUNDARY = (
    "Derived interpolation for presentation only; neither the nine anchors "
    "nor generated nodes are independently validated affect observations, "
    "emotion recognition, or diagnosis."
)
CATALOG_EVIDENCE_BOUNDARY = (
    "Synthetic portrait presets are project-authored presentation assets, not "
    "a demographic taxonomy. Creator-selected presentation styles, regional "
    "design inspirations, and unvalidated skin-tone audit descriptors do not "
    "state or infer sex, gender identity, pronouns, race, ethnicity, ancestry, "
    "nationality, culture, or personal identity. Atlas coordinates and derived "
    "in-between nodes are not independently validated affect observations, "
    "emotion recognition, or diagnosis."
)
PACK_QA_EVIDENCE_BOUNDARY = (
    "Engineering QA of deterministic synthetic image preparation and atlas "
    "generation only. Landmark, topology, continuity, prompt provenance, and "
    "skin-tone descriptors do not establish perceived or validated affect, "
    "demographic identity, cultural authenticity, or representational adequacy."
)
IDENTITY_TYPE = "synthetic-fictional"
SOURCE_OWNERSHIP = "project-owned"
CONSENT_BASIS = "synthetic-source-with-no-real-person-identity-intended"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_module(path: Path, name: str) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Cannot load Python module at {path}.")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def validate_pack_id(value: str) -> str:
    if not isinstance(value, str) or not PACK_ID_PATTERN.fullmatch(value):
        raise ValueError(
            "Pack IDs must be photo-reference-v3 or photo-synthetic-NN "
            "with a two-digit neutral preset number."
        )
    return value


def validate_short_text(value: str, field: str, maximum: int = 160) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text.")
    normalized = " ".join(value.split())
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"{field} must contain 1 to {maximum} visible characters.")
    return normalized


def validate_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must be a lowercase SHA-256 digest.")
    return value


def validate_relative_asset_path(value: Any, field: str, suffix: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"{field} must be a non-empty POSIX relative path.")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or value.startswith("./")
        or "//" in value
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ValueError(f"{field} must stay inside the affect-face asset directory.")
    if ":" in path.parts[0] or not value.endswith(suffix):
        raise ValueError(f"{field} must be a local {suffix} asset path.")
    return value


def atomic_write_json(path: Path, value: Any) -> None:
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


def _connected_black_matte(cell_rgb, np, cv2, black_point: int, opaque_point: int):
    intensity = np.max(cell_rgb, axis=2)
    candidates = (intensity < opaque_point).astype(np.uint8)
    _count, labels = cv2.connectedComponents(candidates, connectivity=8)
    border_labels = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border_labels = border_labels[border_labels != 0]
    connected = np.isin(labels, border_labels)

    scale = max(1, opaque_point - black_point)
    transition = np.clip((intensity.astype(np.float32) - black_point) / scale, 0.0, 1.0)
    transition = transition * transition * (3.0 - 2.0 * transition)
    alpha = np.ones_like(transition, dtype=np.float32)
    alpha[connected] = transition[connected]

    # The generated RGB sheets are straight-color images on black, not known
    # premultiplied-alpha composites. Dividing low-alpha RGB by the inferred
    # matte amplifies harmless dark edge noise into white or colored fringes.
    # Preserve straight RGB instead and clear only fully transparent pixels;
    # the soft alpha then attenuates near-black edge pixels naturally.
    straight_rgb = cell_rgb.astype(np.float32) / 255.0
    straight_rgb[alpha <= 1e-6] = 0.0
    rgba = np.concatenate([straight_rgb, alpha[:, :, None]], axis=2)
    return np.uint8(np.round(rgba * 255.0)), alpha


def prepare_source_rgba(
    input_path: Path,
    output_path: Path,
    builder: ModuleType,
    matte_mode: str = "auto",
    black_point: int = 8,
    opaque_point: int = 24,
) -> dict[str, Any]:
    """Prepare a 3x3 source sheet, deriving alpha only for RGB black mattes.

    RGB conversion is intentionally conservative. In each source cell, only
    near-black components connected to that cell's border are treated as the
    matte. Alpha is a smoothstep from ``black_point`` to ``opaque_point`` over
    the maximum RGB channel. Straight RGB is preserved for partially
    transparent pixels rather than divided by inferred alpha, which avoids
    amplifying dark edge noise into bright fringes. Interior dark features
    remain opaque because they are not border-connected. Truly black hair
    touching a border cannot be separated perfectly from a black matte; that
    limitation is recorded in metadata and requires visual review.
    """

    if matte_mode not in {"auto", "black", "preserve-alpha"}:
        raise ValueError("matte_mode must be auto, black, or preserve-alpha.")
    if not 0 <= black_point < opaque_point <= 255:
        raise ValueError("Matte points must satisfy 0 <= black < opaque <= 255.")

    image = builder.Image.open(input_path)
    input_mode = image.mode
    width, height = image.size
    if width % SOURCE_GRID_SIZE or height % SOURCE_GRID_SIZE:
        raise ValueError("The source atlas dimensions must be divisible by 3.")

    use_black_matte = matte_mode == "black" or (
        matte_mode == "auto" and "A" not in image.getbands()
    )
    if matte_mode == "preserve-alpha" and "A" not in image.getbands():
        raise ValueError("preserve-alpha requires a source image with an alpha channel.")

    if not use_black_matte:
        rgba = builder.np.array(image.convert("RGBA"))
        alpha = rgba[:, :, 3].astype(builder.np.float32) / 255.0
        method = "preserve-source-alpha-v1"
    else:
        rgb = builder.np.array(image.convert("RGB"))
        cell_width = width // SOURCE_GRID_SIZE
        cell_height = height // SOURCE_GRID_SIZE
        rgba = builder.np.zeros((height, width, 4), dtype=builder.np.uint8)
        alpha = builder.np.ones((height, width), dtype=builder.np.float32)
        for row in range(SOURCE_GRID_SIZE):
            for column in range(SOURCE_GRID_SIZE):
                y0, y1 = row * cell_height, (row + 1) * cell_height
                x0, x1 = column * cell_width, (column + 1) * cell_width
                converted, converted_alpha = _connected_black_matte(
                    rgb[y0:y1, x0:x1],
                    builder.np,
                    builder.cv2,
                    black_point,
                    opaque_point,
                )
                rgba[y0:y1, x0:x1] = converted
                alpha[y0:y1, x0:x1] = converted_alpha
        method = "cell-border-connected-rgb-black-matte-soft-alpha-v2"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    builder.Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG")
    transparent = int(builder.np.count_nonzero(alpha <= 1e-6))
    soft_mask = (alpha > 1e-6) & (alpha < 1.0 - 1e-6)
    soft = int(builder.np.count_nonzero(soft_mask))
    opaque = int(alpha.size - transparent - soft)
    return {
        "method": method,
        "inputMode": input_mode,
        "sourceGridSize": SOURCE_GRID_SIZE,
        "backgroundConnectivity": 8 if use_black_matte else None,
        "backgroundSeed": "each 3x3 cell border" if use_black_matte else None,
        "intensityMetric": "maximum RGB channel" if use_black_matte else None,
        "blackPoint": black_point if use_black_matte else None,
        "opaquePoint": opaque_point if use_black_matte else None,
        "alphaCurve": "smoothstep" if use_black_matte else None,
        "edgeRgbPolicy": "preserve-source-straight-rgb" if use_black_matte else None,
        "blackMatteDecontamination": False,
        "transparentPixelCount": transparent,
        "softPixelCount": soft,
        "softPixelMaximumRgb": (
            int(builder.np.max(rgba[:, :, :3][soft_mask])) if soft else 0
        ),
        "opaquePixelCount": opaque,
        "preparedSha256": sha256(output_path),
        "limitation": (
            "Border-connected near-black foreground detail may be inseparable "
            "from a black matte and requires contact-sheet review."
            if use_black_matte
            else "Source alpha is preserved without matte inference."
        ),
    }


def provenance_record(
    generator_name: str,
    generator_version: str,
    generated_on: str,
    generation_record: str,
    license_name: str,
) -> dict[str, str]:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", generated_on):
        raise ValueError("generated_on must use YYYY-MM-DD.")
    try:
        date.fromisoformat(generated_on)
    except ValueError as error:
        raise ValueError("generated_on must be a valid calendar date.") from error
    return {
        "identityType": IDENTITY_TYPE,
        "sourceOwnership": SOURCE_OWNERSHIP,
        "demographicLabelType": "creator-prompt-inspiration-only",
        "demographicLabelScope": DEMOGRAPHIC_LABEL_SCOPE,
        "consentBasis": CONSENT_BASIS,
        "license": validate_short_text(license_name, "license", 80),
        "generatorName": validate_short_text(generator_name, "generator_name", 120),
        "generatorVersion": validate_short_text(generator_version, "generator_version", 120),
        "generatedOn": generated_on,
        "generationRecord": validate_short_text(
            generation_record, "generation_record", 500
        ),
        "affectValidation": AFFECT_VALIDATION_BOUNDARY,
    }


def catalog_entry_from_metadata(
    metadata: dict[str, Any],
    asset_root: Path,
    atlas_path: Path,
    metadata_path: Path,
    qa_path: Path,
    available: bool,
) -> dict[str, Any]:
    def relative(path: Path) -> str:
        try:
            return path.resolve().relative_to(asset_root.resolve()).as_posix()
        except ValueError as error:
            raise ValueError(f"{path} is outside catalog asset root {asset_root}.") from error

    return {
        "id": metadata["id"],
        "label": metadata["label"],
        "presentationStyle": metadata["presentationStyle"],
        "regionalDesignInspirations": metadata["regionalDesignInspirations"],
        "skinToneAudit": metadata["skinToneAudit"],
        "atlas": relative(atlas_path),
        "metadata": relative(metadata_path),
        "qa": relative(qa_path),
        "available": bool(available),
        "gridSize": metadata["gridSize"],
        "tileSize": metadata["tileSize"],
        "quality": metadata["quality"],
        "atlasSha256": metadata["outputSha256"] if available else None,
        "atlasBytes": atlas_path.stat().st_size if available else None,
        "provenance": {
            key: metadata["provenance"][key]
            for key in (
                "identityType",
                "sourceOwnership",
                "demographicLabelType",
                "demographicLabelScope",
                "consentBasis",
                "license",
                "affectValidation",
            )
        },
    }
