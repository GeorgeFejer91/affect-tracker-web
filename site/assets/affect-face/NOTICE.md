# Affect face asset and calibration provenance

This notice covers the local assets in this directory and the compact
calibration tables used by the face renderers. The published application does
not fetch a face model or expression dataset, run face recognition, request a
camera, or send a face image at runtime.

## Detailed 3D head and texture maps

`vitruvian-head.glb`, `skin-base.webp`, `skin-normal.webp`,
`skin-roughness.webp`, `mouth.webp`, `iris.webp`, and `sclera.webp` are
derived from the Vitruvian head and texture assets in
[ibrews/VitruvianGodot](https://github.com/ibrews/VitruvianGodot) at commit
`bdecdcd537b4031fdd0fb299b7e4f93f084fffa0` (accessed 2026-09-03).

The upstream repository identifies these character assets as CC0 1.0 and
credits Vitruvian by Sean Buckley and Olaf Delgado-Friedrichs, derived from
Antonia Polygon and distributed through the CharMorph Blender add-on. The
head was losslessly repacked with glTF Transform meshopt compression. The
texture maps were resized and encoded as WebP for local, offline delivery.
No Mixamo animation or other non-CC0 character asset is included.

The checked-in texture bytes remain unmodified at runtime. The detailed
renderer applies a project-authored, non-destructive material grade that
neutralizes strong sclera/iris color casts, softens excessive red around the
eye sockets, and lowers glossy reflections. It does not alter the morph head,
expression coefficients, source files, or photo atlas.

**License:** the included character-asset derivatives remain under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
VitruvianGodot separately licenses its tools and shaders under MIT; none of
that source code is copied into this directory.

Source license and credits:

- https://github.com/ibrews/VitruvianGodot/blob/bdecdcd537b4031fdd0fb299b7e4f93f084fffa0/LICENSE
- https://github.com/ibrews/VitruvianGodot/blob/bdecdcd537b4031fdd0fb299b7e4f93f084fffa0/NOTICE.md

## AFFEC aggregate evidence and authored bindings

`affec-perceived-va-evidence-v1.json` contains project-computed counts, means,
and sample standard deviations for AFFEC's perceived-emotion valence/arousal
fields across all 5,807 valid observations in AFFEC Multimodal Dataset core
v0.1. Ratings were normalized from the published 1–9 scale with
`(rating - 5) / 4`. The artifact contains dataset-derived aggregates only.
`scripts/build-affec-perceived-va-calibration.py` reproduces it from the exact
official `core.zip`: 5,645,457 bytes, MD5
`7157e9bedacf58f42692688fb20b57b1`, SHA-256
`f5b71a3360a21e05d01f92172ea52bbcc6bb4a763f181da10b8e63af2faf7e99`.

`affec-photoatlas-authoring-binding-v1.json` separately classifies the six
category-to-portrait correspondences, Gaussian transfer, sharpening, and
gates as project-authored. The runtime uses those compiled constants without
fetching either provenance artifact. It keeps tracker `currentX/currentY`
unchanged and uses separate `atlasX/atlasY` only to sample the selected local
atlas. AFFEC supports the aggregate perceived category locations; it does not
validate the portrait mapping, transfer surface, nine source anchors, 441
derived cells, selected fictional identity, emotion recognition, demographic
inference, or diagnosis. The separate Direct-grid Photoatlas remains available
as an authored comparison.

Source: [AFFEC Zenodo record 14794876](https://zenodo.org/records/14794876)
and the [AFFEC devkit repository](https://github.com/itubrainlab/AFFEC).
The Zenodo metadata identifies the dataset as **CC BY 4.0**, while the
accompanying repository currently describes the dataset files as **CC0**. This
project follows the more conservative
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) attribution path for
the redistributed aggregate statistics and identifies the transformation
above. No AFFEC image, audio, video, participant identifier, demographic
field, stimulus path, or trial-level row is shipped or loaded by the
application.

## MediaPipe build-time coefficient extraction

`site/src/face-mediapipe-calibration.js` stores compact summaries of 52
blendshape coefficients extracted once from the nine cells of the
project-owned atlas below with MediaPipe Face Landmarker package version
0.10.21. The coefficient reduction and mapping to Vitruvian morph names are
project-authored.

MediaPipe tooling and the blendshape model described by the
[Face Blendshapes V2 model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf)
are provided under the
[Apache License 2.0](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE).
No MediaPipe JavaScript/WASM, task model, or camera processing is included in
or executed by the published application.

## Photorealistic compatibility atlas

`affect-face-atlas-v1.webp` is a project-created synthetic digital-human
expression atlas generated for this application. It depicts a fictional
person and contains the nine source anchors retained for provenance and for
the separate MediaPipe-blendshape calibration described above.

`affect-face-atlas-v3.webp` is the 21 by 21 Canvas compatibility atlas used at
runtime. Its 441 cells were generated locally from those nine unchanged
anchors by `scripts/build-dense-photo-atlas.py`. During this offline-only
asset step, MediaPipe Face Mesh 0.10.8 supplied corresponding semantic
landmarks; the project script interpolated a target landmark mesh, applied
piecewise affine warps, and combined the four neighboring cells in
premultiplied alpha.
The adjacent JSON records both asset hashes, tool versions, a 160 px cell
size, and the mesh size. No dataset face, new identity, or independently
labelled affect observation is introduced by these derived in-between cells.
No MediaPipe code or model is included in or executed by the application.

The earlier 11 by 11 v2 atlas remains checked in as a reproducibility and
rollback artifact but is not requested by the current renderer.

`affect-face-atlas-v3-qa.json` is reproduced by
`scripts/verify-dense-photo-atlas.py`. It checks hashes, all 441 face
detections, landmark agreement and neighbor continuity, mesh topology, and
the nine source-anchor pixels. These are deterministic rendering checks only;
they do not establish perceived or validated valence/arousal.

Both atlases are project-owned, were not copied from a human photograph or a
third-party face-expression dataset, and are distributed under this
repository's [BSD 3-Clause License](../../../LICENSE).

## Separately packaged synthetic portrait presets

`photo-atlas-packs-v1.json` is the closed-world catalog for the original
portrait and seven optional, separately stored synthetic portrait presets.
The browser loads only the selected local WebP, so adding presets does not add
their bytes to the initial page or require a runtime model, camera, remote
service, or CDN. Public labels remain the neutral `Original portrait` and
`Synthetic preset 02` through `Synthetic preset 08` names.

Each preset begins as a project-owned 3 by 3 fictional portrait sheet in
`packs/<neutral-id>/anchors-v1.png`. Internal `presentationStyle`,
`regionalDesignInspirations`, and `skinToneAudit` fields record creator-prompt
provenance and an explicitly unvalidated audit descriptor. They are not a
demographic taxonomy or a claim or inference about sex, gender identity,
pronouns, race, ethnicity, ancestry, nationality, culture, or personal
identity. They also do not make the anchors or interpolated nodes validated
affect observations, emotion recognition, or diagnosis.

The supplied PNG anchor sheets use an RGB black matte rather than source
alpha. `scripts/build-photo-atlas-pack.py` deterministically derives soft
alpha independently in each source cell: near-black pixels are candidates,
only 8-connected components that reach that cell's border are treated as
background, maximum RGB intensity is mapped through a smoothstep from 8 to 24,
and partially transparent pixels preserve their straight source RGB. The
algorithm deliberately does not divide RGB by inferred alpha, because doing so
amplifies dark edge noise into colored or white fringes. Interior dark facial
features stay opaque. Truly black foreground detail that touches a cell border
can remain inseparable from the matte, so visual contact-sheet review is still
required.

The pack builder delegates its 21 by 21 landmark warp to the unchanged v3
builder. Each colocated metadata and QA file binds the source, prepared source,
derived atlas, exact tool hashes, generation record, engineering checks, and
evidence boundaries. `scripts/verify-photo-atlas-pack.py` reproduces each pack;
`scripts/verify-photo-atlas-catalog.py` additionally fails closed on unsafe
paths, stale hashes, unavailable defaults, non-neutral public names, or QA that
has not passed. These are deterministic rendering checks, not demographic,
representational, or perceived-affect validation.

## Local rendering libraries

The detailed renderer uses locally vendored
[three.js r184](https://github.com/mrdoob/three.js/tree/r184) modules under the
MIT License; the complete local license is retained at
[`site/vendor/three/0.184.0/LICENSE`](../../vendor/three/0.184.0/LICENSE).

`MeshoptDecoder`, built from meshoptimizer 1.1, is also MIT-licensed and
retains its upstream notice: Copyright (c) 2016–2026 Arseny Kapoulkine. The
vendored module is
[`meshopt_decoder.module.js`](../../vendor/three/0.184.0/examples/jsm/libs/meshopt_decoder.module.js),
and its upstream source and license are at
[zeux/meshoptimizer](https://github.com/zeux/meshoptimizer). These libraries
and all face assets are served locally; no CDN is used.
