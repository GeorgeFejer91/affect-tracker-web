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

## AFFEC empirical aggregate calibration

`site/src/face-affec.js` contains project-computed counts, means, and standard
deviations for AFFEC's perceived-emotion valence/arousal fields across all
5,807 valid trials in AFFEC Multimodal Dataset core v0.1. Ratings were
normalized from the published 1–9 scale with `(rating - 5) / 4`. The category
prototype morphs and continuous RBF interpolation are project-authored.

Source: [AFFEC Zenodo record 14794876](https://zenodo.org/records/14794876)
and the [AFFEC devkit repository](https://github.com/itubrainlab/AFFEC).
The Zenodo metadata identifies the dataset as **CC BY 4.0**, while the
accompanying repository currently describes the dataset files as **CC0**. This
project follows the more conservative
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) attribution path for
the redistributed aggregate statistics and identifies the transformation
above. No AFFEC image, audio, video, participant record, or trial-level row is
shipped or loaded by the application.

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
