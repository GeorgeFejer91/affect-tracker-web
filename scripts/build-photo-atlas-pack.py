#!/usr/bin/env python3
"""Build one independently stored 21x21 synthetic Photoatlas identity pack.

This wrapper deliberately leaves ``build-dense-photo-atlas.py`` unchanged so
the checked-in v3 atlas, metadata, QA report, and their recorded tool hashes
remain reproducible. It prepares RGB black-matte anchor sheets deterministically,
delegates geometry generation to the pinned dense builder, and adds the pack and
source-provenance contract required by the lazy-loadable catalog.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from photo_atlas_pack_common import (
    AFFECT_VALIDATION_BOUNDARY,
    PACK_METADATA_SCHEMA,
    PACK_METADATA_VERSION,
    PRESENTATION_STYLES,
    REGIONAL_DESIGN_INSPIRATIONS,
    atomic_write_json,
    catalog_entry_from_metadata,
    load_module,
    prepare_source_rgba,
    provenance_record,
    sha256,
    validate_pack_id,
    validate_short_text,
)


DEFAULT_ASSET_ROOT = Path("site/assets/affect-face")
DEFAULT_BUILDER = Path("scripts/build-dense-photo-atlas.py")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--pack-id", required=True)
    result.add_argument("--label", required=True)
    result.add_argument(
        "--presentation-style", required=True, choices=sorted(PRESENTATION_STYLES)
    )
    result.add_argument(
        "--regional-design-inspiration",
        action="append",
        default=[],
        choices=sorted(REGIONAL_DESIGN_INSPIRATIONS),
        help=(
            "Repeatable internal creator-prompt provenance. This is never an "
            "identity, ancestry, or ethnicity inference."
        ),
    )
    result.add_argument("--skin-tone-audit-descriptor", default=None)
    result.add_argument("--generator-name", required=True)
    result.add_argument("--generator-version", required=True)
    result.add_argument("--generated-on", required=True)
    result.add_argument("--generation-record", required=True)
    result.add_argument("--license", default="BSD-3-Clause")
    result.add_argument("--asset-root", type=Path, default=DEFAULT_ASSET_ROOT)
    result.add_argument("--input", type=Path, default=None)
    result.add_argument("--output", type=Path, default=None)
    result.add_argument("--metadata", type=Path, default=None)
    result.add_argument("--qa", type=Path, default=None)
    result.add_argument("--catalog-entry-out", type=Path, default=None)
    result.add_argument("--builder", type=Path, default=DEFAULT_BUILDER)
    result.add_argument(
        "--matte-mode", choices=("auto", "black", "preserve-alpha"), default="auto"
    )
    result.add_argument("--matte-black-point", type=int, default=8)
    result.add_argument("--matte-opaque-point", type=int, default=24)
    result.add_argument("--grid-size", type=int, default=21)
    result.add_argument("--tile-size", type=int, default=160)
    result.add_argument("--quality", type=int, default=82)
    result.add_argument("--force", action="store_true")
    return result


def resolved_paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path, Path]:
    asset_root = args.asset_root.resolve()
    pack_directory = asset_root / "packs" / args.pack_id
    input_path = (args.input or pack_directory / "anchors-v1.png").resolve()
    output_path = (args.output or pack_directory / "atlas-v1.webp").resolve()
    metadata_path = (args.metadata or pack_directory / "atlas-v1.json").resolve()
    qa_path = (args.qa or pack_directory / "atlas-v1-qa.json").resolve()
    return asset_root, input_path, output_path, metadata_path, qa_path


def validate_args(args: argparse.Namespace) -> None:
    args.pack_id = validate_pack_id(args.pack_id)
    if args.pack_id == "photo-reference-v3":
        raise ValueError(
            "The legacy photo-reference-v3 pack is immutable; build a neutral "
            "photo-synthetic-NN pack instead."
        )
    args.label = validate_short_text(args.label, "label", 80)
    if len(args.regional_design_inspiration) != len(set(args.regional_design_inspiration)):
        raise ValueError("Regional design inspirations must be unique.")
    if len(args.regional_design_inspiration) > 4:
        raise ValueError("At most four regional design inspirations may be recorded.")
    if args.skin_tone_audit_descriptor is not None:
        args.skin_tone_audit_descriptor = validate_short_text(
            args.skin_tone_audit_descriptor, "skin_tone_audit_descriptor", 160
        )
    if args.grid_size < 3 or args.grid_size % 2 == 0:
        raise ValueError("--grid-size must be an odd integer of at least 3.")
    if not 96 <= args.tile_size <= 512:
        raise ValueError("--tile-size must be between 96 and 512 pixels.")
    if not 1 <= args.quality <= 100:
        raise ValueError("--quality must be between 1 and 100.")
    if not 0 <= args.matte_black_point < args.matte_opaque_point <= 255:
        raise ValueError("Matte points must satisfy 0 <= black < opaque <= 255.")


def build(args: argparse.Namespace) -> dict:
    validate_args(args)
    asset_root, input_path, output_path, metadata_path, qa_path = resolved_paths(args)
    if not input_path.is_file():
        raise FileNotFoundError(f"Source anchor sheet does not exist: {input_path}")
    for destination in (output_path, metadata_path):
        if destination.exists() and not args.force:
            raise FileExistsError(f"Refusing to overwrite {destination}; pass --force explicitly.")

    builder_path = args.builder.resolve()
    common_path = Path(__file__).with_name("photo_atlas_pack_common.py").resolve()
    builder = load_module(builder_path, "affect_dense_atlas_builder_for_pack")
    provenance = provenance_record(
        args.generator_name,
        args.generator_version,
        args.generated_on,
        args.generation_record,
        args.license,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{args.pack_id}-build-", dir=output_path.parent
    ) as temporary_name:
        temporary = Path(temporary_name)
        prepared_path = temporary / "prepared-anchors.png"
        temporary_atlas = temporary / output_path.name
        temporary_metadata = temporary / metadata_path.name
        preprocessing = prepare_source_rgba(
            input_path,
            prepared_path,
            builder,
            args.matte_mode,
            args.matte_black_point,
            args.matte_opaque_point,
        )
        builder.build_dense_atlas(
            prepared_path,
            temporary_atlas,
            temporary_metadata,
            args.grid_size,
            args.tile_size,
            args.quality,
        )
        base = json.loads(temporary_metadata.read_text(encoding="utf-8"))
        metadata = {
            "schema": PACK_METADATA_SCHEMA,
            "version": PACK_METADATA_VERSION,
            "id": args.pack_id,
            "label": args.label,
            "presentationStyle": args.presentation_style,
            "regionalDesignInspirations": list(args.regional_design_inspiration),
            "skinToneAudit": (
                {
                    "status": "unvalidated",
                    "descriptor": args.skin_tone_audit_descriptor,
                }
                if args.skin_tone_audit_descriptor
                else None
            ),
            "source": input_path.name,
            "sourceSha256": sha256(input_path),
            "preparedSourceSha256": preprocessing["preparedSha256"],
            "sourcePreprocessing": preprocessing,
            "output": output_path.name,
            "outputSha256": sha256(temporary_atlas),
            "sourceGridSize": base["sourceGridSize"],
            "gridSize": base["gridSize"],
            "nodeCount": base["nodeCount"],
            "tileSize": base["tileSize"],
            "quality": base["quality"],
            "controlPointCount": base["controlPointCount"],
            "triangleCount": base["triangleCount"],
            "topologySweepSize": base["topologySweepSize"],
            "minimumTriangleAreaPixels": base["minimumTriangleAreaPixels"],
            "method": base["method"],
            "runtimeInterpolation": base["runtimeInterpolation"],
            "affectValidation": AFFECT_VALIDATION_BOUNDARY,
            "versions": base["versions"],
            "tooling": {
                "denseBuilder": builder_path.name,
                "denseBuilderSha256": sha256(builder_path),
                "packBuilder": Path(__file__).name,
                "packBuilderSha256": sha256(Path(__file__).resolve()),
                "packCommon": common_path.name,
                "packCommonSha256": sha256(common_path),
            },
            "provenance": provenance,
        }
        os.replace(temporary_atlas, output_path)
        atomic_write_json(metadata_path, metadata)

    if args.catalog_entry_out:
        entry = catalog_entry_from_metadata(
            metadata, asset_root, output_path, metadata_path, qa_path, available=False
        )
        atomic_write_json(args.catalog_entry_out.resolve(), entry)
    return metadata


def main() -> None:
    args = parser().parse_args()
    metadata = build(args)
    print(json.dumps(metadata, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
