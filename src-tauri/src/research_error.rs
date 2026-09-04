use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn forbidden(message: impl Display) -> Self {
        Self::new("forbidden_operation", message.to_string())
    }

    pub fn invalid_contract(message: impl Into<String>) -> Self {
        Self::new("invalid_research_contract", message)
    }

    pub fn workspace_required() -> Self {
        Self::new(
            "workspace_required",
            "Choose a Research workspace before using this operation.",
        )
    }

    pub fn unsupported_source(message: impl Into<String>) -> Self {
        Self::new("unsupported_stimulus_source", message)
    }

    pub fn no_active_run() -> Self {
        Self::new("no_active_run", "There is no active Research run.")
    }

    pub fn run_active() -> Self {
        Self::new(
            "run_already_active",
            "Finish the active Research run before starting another attempt.",
        )
    }

    pub fn native_media_unavailable(reason_code: &str) -> Self {
        let reason = if reason_code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !reason_code.is_empty()
            && reason_code.len() <= 96
        {
            reason_code
        } else {
            "native-media-unavailable"
        };
        Self::new(
            "native_media_unavailable",
            format!(
                "Qualified native playback is unavailable ({reason}). Explicitly choose unqualified WebView playback only for non-qualification work."
            ),
        )
    }

    pub fn io(_: impl Display) -> Self {
        // OS errors can contain private absolute paths. The structured boundary deliberately
        // trades that detail for a stable, path-free participant-facing failure.
        Self::new(
            "research_io",
            "The Research workspace operation could not be completed.",
        )
    }
}

impl Display for CommandError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<std::io::Error> for CommandError {
    fn from(_: std::io::Error) -> Self {
        Self::io("The Research workspace operation could not be completed.")
    }
}

pub type ResearchResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_errors_are_stable_and_path_free() {
        let value = serde_json::to_value(CommandError::io(
            "C:\\private\\participant\\ratings.csv failed",
        ))
        .unwrap();
        assert_eq!(value["code"], "research_io");
        assert_eq!(
            value["message"],
            "The Research workspace operation could not be completed."
        );
        assert!(!value.to_string().contains("private"));
        assert!(value.as_object().is_some_and(|object| object.len() == 2));
    }
}
