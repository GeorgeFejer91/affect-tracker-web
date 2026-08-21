use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn forbidden() -> Self {
        Self::new(
            "forbidden_window",
            "This operation is available only in the settings window.",
        )
    }
}

impl From<std::io::Error> for CommandError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "settings_io",
            "The application could not save its settings.",
        )
    }
}
