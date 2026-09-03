use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{Display, Formatter};

/// Stable machine-readable failure categories exposed by the core boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreErrorCodeV1 {
    InvalidSchema,
    InvalidValue,
    LimitExceeded,
    DuplicateId,
    MissingReference,
    HashMismatch,
    CapabilityMissing,
    StaleGeneration,
    StaleRevision,
    RunMismatch,
    PhasePreconditionFailed,
    BlockPreconditionFailed,
    InvalidTransition,
    IncompleteQuestionnaire,
    TimeRegression,
    SerializationFailed,
}

/// Serializable error safe to return across native or WASM adapter boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreErrorV1 {
    pub code: CoreErrorCodeV1,
    pub path: String,
    pub message: String,
}

impl CoreErrorV1 {
    pub(crate) fn new(
        code: CoreErrorCodeV1,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl Display for CoreErrorV1 {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

impl Error for CoreErrorV1 {}

pub type CoreResult<T> = Result<T, CoreErrorV1>;
