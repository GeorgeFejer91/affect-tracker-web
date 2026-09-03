# Portable WebXR study-panel adapter

This directory contains a dependency-free, pure JavaScript foundation for the
portable immersive study UI. It projects already validated `StudyDefinitionV1`
blocks into bounded renderer-neutral panel models and translates semantic
controller input into transient UI state plus typed study-command effects.

`webxr.html` now wires these adapters to a deliberately gated
`content-asset-media-v1` mode. That mode loads and hash-verifies an immutable
published definition in the ordinary 2D page, requires the native-equivalent
WASM authority and IndexedDB journal, checks runtime capabilities, then runs
instruction, content-addressed video, questionnaire, break, and completion
blocks in immersive VR. It
does not own random order, questionnaire commits, branching, or lifecycle
transitions: those remain authority actions. It is not evidence of physical
Quest qualification.

The existing single-stimulus runner remains a separate explicitly selected
legacy mode. Portable media selection and SHA-256 matching happen in 2D. The
runtime binds only a matching file whose first frame decodes and whose duration
matches the published descriptor, resolves block clips over asset
defaults, and supports flat, equirectangular 180°/360°, mono, side-by-side
left/right, and top/bottom presentation. YouTube remains a Pages 2D-only
exception. Unsupported sources, codecs, projection/stereo tokens, missing
bindings, or invalid clip bounds fail rather than skip or substitute a block.
The legacy media clock is never treated as the portable study clock.

## Authority boundary

The browser WASM study authority remains the source of run identity, revision,
phase, current section/trial/block, order, timing, and committed responses. An
integration resolves the current block definition from those authoritative IDs,
then uses this adapter only to present and collect a response:

1. Validate and hash the published study with the shared Rust/WASM core.
2. Observe real runtime capabilities and hash-verify every referenced local or
   repository asset.
3. Call `evaluatePortableWebXrRuntimePreflight`. Do not request immersive mode
   when `ok` is false. Controller presence is then observed immediately after
   XR access and before the authority starts, because WebXR does not expose
   session input sources before a session exists.
4. Create transient state with `createXrPanelState` when the authoritative
   current block changes.
5. Render `projectPortableBlockToXrPanel` without resizing the logical panel or
   inventing hidden controls.
6. Map XR controller/gamepad readings to `{ x, y, select, back }`, use
   `controllerIntentFromSnapshot` for edge-triggered intent, and pass that intent
   to `reduceXrPanelController`.
7. When a reducer returns a `studyCommand` effect, wrap its `command` in the
   complete `StudyActionV1` envelope (fresh action ID and clocks, current run ID,
   authority generation, expected revision, and phase/block precondition) and
   submit it to the shared authority. Never apply the lifecycle transition here.

For a video block, the host creates an object URL only from its verified file,
seeks to the resolved clip start, and reports a relative media timeline through
the authority. `playing=true` is committed before any affect sample. Sampling
uses the published rate only while a decoded frame is actively playing; pause,
buffer stall, clip end, controller loss, or session loss stops the scheduler.
Slow journal writes produce timing gaps, never invented catch-up samples. A
participant cannot advance until the selected segment completes. The object URL
is revoked at block exit.

`XR_PANEL_ADAPTER_CAPABILITIES` names logical features supplied by these pure
modules. The host must separately report observed `controllerInput`,
`durableJournal`, affect/media support, and the exact MIME types it can play.
Passing a platform name is not capability evidence.

## Questionnaire interaction

All seven portable v1 types are represented: acknowledgement, single choice,
multiple choice, Likert, VAS, numeric, and 2D affect. Long prompts and choices
are paginated into fixed bounds. Focus is explicit and stable. A scale uses
left/right; a 2D affect item uses all four directions. Press Select to confirm a
scale or 2D point and move focus to the forward action. Only the completed
`submitQuestionnaire` command contains answers; intermediate controller changes
remain transient and must not be journaled as questionnaire responses.

Universal v1 permits only the shared core's single typed `runIf` condition on a
trial, based on a required answer from an earlier fixed unconditional
questionnaire. The WASM authority resolves and records that condition before
this adapter sees a block. Free text, nested/compound or scripted branching,
scoring, arbitrary HTML, and an immersive study designer remain out of scope.

## Face + Flubber instruction presentation

`faceFlubberComparison` is an optional presentation of an `instruction` block,
not a phase, trial, stimulus, input, recognition result, or data source. Pass one
already authoritative `{ currentX, currentY, phase }` snapshot to
`projectPortableBlockToXrPanel`. The returned face and Flubber projections share
that exact frozen snapshot object; the adapter never clamps or recomputes it.
The renderer uses the canonical vector face and canonical Flubber, not the main
tracker's five selectable face engines. It must preserve the established
reduced-motion and accessibility semantics and label the comparison as
presentation-only and non-diagnostic.

## Rendering and qualification

Panel placement is a bounded gaze-aligned model, not a DOM/CSS design or scene
implementation. A host renderer remains responsible for legible typography,
contrast, focus indication, controller rays, reduced motion, safe placement,
and media layers. The UI model deliberately uses conventional labels and a
small stable control set rather than decorative cards or animation.

Unit tests prove logical bounds, navigation, answer shapes, clip resolution,
UV mapping, 180° geometry, non-catch-up sampling, and preflight rejection. The
integration tests drive panel and video actions through the real shared WASM
authority. Research support still requires real-browser and physical Quest
2/3/3S qualification for text legibility, controller mapping, media codecs,
storage/quota behavior, headset lifecycle, recovery, and performance.
