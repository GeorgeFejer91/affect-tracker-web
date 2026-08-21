use crate::domain::{Action, AffectPalette, InputMode};
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub input_mode: InputMode,
    pub step_size: f32,
    pub continuous_speed: f32,
    pub response: f32,
    pub bindings: HashMap<Action, String>,
    pub palette: AffectPalette,
    pub overlay: OverlaySettings,
    pub lsl: LslSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlaySettings {
    pub x: i32,
    pub y: i32,
    pub size: u32,
    pub opacity: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LslSettings {
    pub stream_name: String,
    pub stream_type: String,
    pub marker_name: String,
    pub sample_rate: u32,
    pub source_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            input_mode: InputMode::Continuous,
            step_size: 0.1,
            continuous_speed: 0.8,
            response: 8.0,
            bindings: HashMap::from([
                (Action::IncreaseValence, "key:ArrowRight".into()),
                (Action::DecreaseValence, "key:ArrowLeft".into()),
                (Action::IncreaseArousal, "key:ArrowUp".into()),
                (Action::DecreaseArousal, "key:ArrowDown".into()),
                (Action::Reset, "key:KeyR".into()),
                (Action::TogglePause, "key:Space".into()),
                (Action::ShowSettings, "key:F10".into()),
                (Action::ToggleOverlayEditing, "key:F9".into()),
            ]),
            palette: AffectPalette::default(),
            overlay: OverlaySettings::default(),
            lsl: LslSettings::default(),
        }
    }
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            x: 120,
            y: 120,
            size: 240,
            opacity: 0.95,
            visible: true,
        }
    }
}

impl Default for LslSettings {
    fn default() -> Self {
        Self {
            stream_name: "AffectTracker".into(),
            stream_type: "Affect".into(),
            marker_name: "AffectTrackerMarkers".into(),
            sample_rate: 50,
            source_id: "affect-tracker-desktop".into(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), CommandError> {
        if self.version != SETTINGS_VERSION {
            return Err(CommandError::new(
                "unsupported_settings",
                "The settings schema version is not supported.",
            ));
        }
        validate_range("step size", self.step_size, 0.01, 1.0)?;
        validate_range("continuous speed", self.continuous_speed, 0.05, 4.0)?;
        validate_range("smoothing response", self.response, 0.1, 30.0)?;
        if !(120..=640).contains(&self.overlay.size) {
            return Err(CommandError::new(
                "invalid_overlay_size",
                "Overlay size must be between 120 and 640 pixels.",
            ));
        }
        validate_range("overlay opacity", self.overlay.opacity, 0.0, 1.0)?;
        if !(1..=240).contains(&self.lsl.sample_rate) {
            return Err(CommandError::new(
                "invalid_lsl_rate",
                "LSL sample rate must be between 1 and 240 Hz.",
            ));
        }
        for (label, value, maximum) in [
            ("LSL stream name", self.lsl.stream_name.as_str(), 80),
            ("LSL stream type", self.lsl.stream_type.as_str(), 80),
            ("LSL marker name", self.lsl.marker_name.as_str(), 80),
            ("LSL source ID", self.lsl.source_id.as_str(), 120),
        ] {
            if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
                return Err(CommandError::new(
                    "invalid_lsl_metadata",
                    format!("{label} is empty or too long."),
                ));
            }
        }
        let required: HashSet<Action> = [
            Action::IncreaseValence,
            Action::DecreaseValence,
            Action::IncreaseArousal,
            Action::DecreaseArousal,
            Action::Reset,
            Action::TogglePause,
            Action::ShowSettings,
            Action::ToggleOverlayEditing,
        ]
        .into_iter()
        .collect();
        if self.bindings.keys().copied().collect::<HashSet<_>>() != required {
            return Err(CommandError::new(
                "missing_binding",
                "Every desktop action must have one shortcut assignment.",
            ));
        }
        let mut unique = HashSet::new();
        for binding in self.bindings.values() {
            let normalized = binding.trim().to_ascii_lowercase();
            if !valid_binding(&normalized) {
                return Err(CommandError::new(
                    "invalid_binding",
                    "Bindings must identify one captured key, mouse button, or wheel direction.",
                ));
            }
            if !unique.insert(normalized) {
                return Err(CommandError::new(
                    "shortcut_conflict",
                    "Every shortcut assignment must be unique.",
                ));
            }
        }
        for color in [
            &self.palette.up,
            &self.palette.down,
            &self.palette.left,
            &self.palette.right,
        ] {
            if !valid_hex_color(color) {
                return Err(CommandError::new(
                    "invalid_palette",
                    "Palette colors must use six-digit hex notation such as #5dffb0.",
                ));
            }
        }
        Ok(())
    }
}

fn valid_binding(value: &str) -> bool {
    let Some((kind, control)) = value.split_once(':') else {
        return false;
    };
    if control.is_empty() || control.len() > 40 {
        return false;
    }
    match kind {
        "key" => control
            .chars()
            .all(|character| character.is_ascii_alphanumeric()),
        "mouse" => matches!(control, "left" | "right" | "middle" | "button4" | "button5"),
        "wheel" => matches!(control, "up" | "down" | "left" | "right"),
        _ => false,
    }
}

fn valid_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn validate_range(label: &str, value: f32, minimum: f32, maximum: f32) -> Result<(), CommandError> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return Err(CommandError::new(
            "invalid_range",
            format!("{label} must be between {minimum} and {maximum}."),
        ));
    }
    Ok(())
}

pub fn load(path: &Path) -> Settings {
    let Ok(contents) = fs::read_to_string(path) else {
        return Settings::default();
    };
    let Ok(mut settings) = serde_json::from_str::<Settings>(&contents) else {
        return Settings::default();
    };
    if matches!(
        settings.validate(),
        Err(CommandError {
            code: "invalid_binding" | "missing_binding" | "shortcut_conflict",
            ..
        })
    ) {
        settings.bindings = Settings::default().bindings;
    }
    if settings.validate().is_ok() {
        settings
    } else {
        Settings::default()
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), CommandError> {
    settings.validate()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_vec_pretty(settings).map_err(|_| {
        CommandError::new(
            "settings_encode",
            "The application could not encode its settings.",
        )
    })?;
    fs::write(path, encoded)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        Settings::default().validate().unwrap();
    }

    #[test]
    fn duplicate_shortcuts_are_rejected_case_insensitively() {
        let mut value = Settings::default();
        let duplicate = value.bindings[&Action::Reset].clone();
        value.bindings.insert(Action::IncreaseValence, duplicate);
        assert_eq!(value.validate().unwrap_err().code, "shortcut_conflict");
    }

    #[test]
    fn defaults_use_plain_arrow_keys_for_affect_axes() {
        let value = Settings::default();
        assert_eq!(value.bindings[&Action::IncreaseValence], "key:ArrowRight");
        assert_eq!(value.bindings[&Action::DecreaseValence], "key:ArrowLeft");
        assert_eq!(value.bindings[&Action::IncreaseArousal], "key:ArrowUp");
        assert_eq!(value.bindings[&Action::DecreaseArousal], "key:ArrowDown");
    }

    #[test]
    fn invalid_numeric_values_are_rejected() {
        let value = Settings {
            step_size: f32::NAN,
            ..Settings::default()
        };
        assert_eq!(value.validate().unwrap_err().code, "invalid_range");
    }

    #[test]
    fn overlay_can_be_fully_transparent() {
        let value = Settings {
            overlay: OverlaySettings {
                opacity: 0.0,
                ..OverlaySettings::default()
            },
            ..Settings::default()
        };
        value.validate().unwrap();
    }

    #[test]
    fn github_pages_default_json_deserializes_as_desktop_settings() {
        let value: Settings = serde_json::from_str(include_str!("../../site/settings.json")).unwrap();
        value.validate().unwrap();
        assert_eq!(value.overlay.size, 240);
        assert_eq!(value.bindings[&Action::IncreaseValence], "key:ArrowRight");
        assert_eq!(value.lsl.stream_name, "AffectTracker");
    }
}
