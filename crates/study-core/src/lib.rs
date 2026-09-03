//! Platform-neutral Affect Tracker study contracts and authoritative reducer.
//!
//! The crate deliberately has no filesystem, networking, UI, Tauri, or clock
//! authority. Platform adapters validate external input, supply observed clock
//! values, and persist the immutable events returned by [`StudyAuthorityV1`].

#![forbid(unsafe_code)]

mod canonical;
mod error;
mod model;
mod ordering;
mod reducer;
mod validation;

#[cfg(feature = "wasm")]
mod wasm;

pub use canonical::{canonical_protocol_bytes, protocol_hash, CANONICAL_PROTOCOL_ALGORITHM_V1};
pub use error::{CoreErrorCodeV1, CoreErrorV1, CoreResult};
pub use model::*;
pub use ordering::{
    resolve_study_order, seeded_trial_order, williams_matrix_sha256, williams_rows,
    FIXED_ORDER_ALGORITHM_V1, SEEDED_ORDER_ALGORITHM_V1, WILLIAMS_MATRIX_HASH_ALGORITHM_V1,
    WILLIAMS_ORDER_ALGORITHM_V1,
};
pub use reducer::StudyAuthorityV1;

#[cfg(feature = "wasm")]
pub use wasm::{
    protocol_hash_json_v1, publish_study_json_v1, validate_result_manifest_json_v1,
    WasmStudyAuthorityV1,
};
