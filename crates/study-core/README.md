# Affect Tracker study core

`affect-tracker-study-core` is the platform-neutral contract and authoritative
state machine for mirrored Affect Tracker studies. It is intentionally free of
Tauri, DOM, WebXR, filesystem, networking, media-player, storage, and clock
authority. Desktop adapters call it natively; Pages and WebXR adapters compile
the same code with the optional `wasm` feature.

## Authority boundary

- `StudyDefinitionV1` is a strict, immutable, content-hashed protocol.
- `RunConfigurationV1` supplies a run ID, 128-bit seed and/or one-based Williams
  group when required, platform capabilities, and initial adapter health.
- `StudyAuthorityV1` is the sole reducer. Every accepted action checks run,
  authority generation, revision, phase, block, and caller-supplied monotonic
  time before advancing the revision once.
- `ReducerOutcomeV1.events` contains immutable events for the platform adapter
  to append durably. The core does not perform I/O or retain an unbounded log.
- Media clocks, wall/monotonic clocks, storage, input, LSL, and rendering stay
  in platform adapters and are reported through typed values.

The Face + Flubber comparison is an instruction presentation variant:

```json
{
  "type": "instruction",
  "blockId": "intro-comparison",
  "content": "Compare the two synchronized representations.",
  "presentation": "faceFlubberComparison"
}
```

It is not a stimulus or independent block type. Adapters must render both from
one shared current valence/arousal/phase frame; the core grants it no input or
state authority.

## Minimal conditional trials

A trial may carry one optional `runIf`. It is deliberately a predicate, not a
general flow language:

```json
{
  "trialId": "condition-b",
  "label": "Condition B",
  "runIf": {
    "operator": "equals",
    "questionnaireBlockId": "preflight-form",
    "itemId": "handedness",
    "value": {
      "type": "singleChoice",
      "optionId": "right"
    }
  },
  "blocks": [
    {
      "type": "instruction",
      "blockId": "condition-b-instruction",
      "content": "Condition B.",
      "presentation": "standard"
    }
  ]
}
```

`equals` accepts a type-matched acknowledgement, single-choice, Likert, VAS,
numeric, or 2D-affect literal. `contains` tests one option in a multiple-choice
answer. There is no negation, AND/OR, nesting, expression text, code, scoring,
or navigation target. The referenced item must be required, and its explicit
questionnaire block must belong to an earlier fixed section and an
unconditional trial. Those constraints prove that the answer has committed
before the condition can be evaluated. An acknowledgement literal must be
`true`, because a required acknowledgement cannot commit `false`. A trial that
contains the required completion block cannot carry `runIf`, keeping the
terminal path unconditionally reachable.

The authority keeps committed answers outside `RunStateV1`. On entry to every
conditional trial it emits `trialBranchDecided`. A false result is immediately
followed by `trialSkipped`; scanning continues until the next eligible block.
These events include the condition, observed typed answer, decision, and
candidate section/trial identity, making the realized branch reconstructable
without adding backward jumps.

## Native API

- `StudyDefinitionV1::{validate_draft, validate_published, published}`
- `canonical_protocol_bytes` and `protocol_hash`
- `seeded_trial_order`, `williams_rows`, `williams_matrix_sha256`, and
  `resolve_study_order`
- `StudyAuthorityV1::{new, study, configuration, state, current_block, apply}`
- `ResultManifestV1::validate`

## WASM API

Enable feature `wasm`. `WasmStudyAuthorityV1` accepts and returns strict JSON
strings through `stateJson()` and `applyJson()`. Free exports
`publishStudyJsonV1()` and `protocolHashJsonV1()` use the identical native
validation and hashing code. JSON uses camel-case field names.

Run-event sequences are one-based. `RunStateV1.lastEventSequence == 0` means
that no event has been committed. A resolved Williams order includes both its
one-based `counterbalanceGroup` and the digest of the complete generated matrix
as `matrixSha256`.

The `fixtures/` directory pins a complete draft, run configuration, action,
event, branch decision/skip events, canonical protocol digest, seeded order,
odd/even Williams rows, matrix digest, and realized order for native/browser
interoperability tests.

## Local checks

```text
cargo fmt --manifest-path crates/study-core/Cargo.toml -- --check
cargo clippy --manifest-path crates/study-core/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path crates/study-core/Cargo.toml --all-features
cargo build --manifest-path crates/study-core/Cargo.toml --target wasm32-unknown-unknown --features wasm --release
```
