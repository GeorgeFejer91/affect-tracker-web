use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AffectPalette {
    pub up: String,
    pub down: String,
    pub left: String,
    pub right: String,
}

impl Default for AffectPalette {
    fn default() -> Self {
        Self {
            up: "#ffd166".into(),
            down: "#5c7cfa".into(),
            left: "#ff5b68".into(),
            right: "#5dffb0".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    IncreaseValence,
    DecreaseValence,
    IncreaseArousal,
    DecreaseArousal,
    Reset,
    TogglePause,
    ShowSettings,
    ToggleOverlayEditing,
}

impl Action {
    pub fn is_directional(self) -> bool {
        matches!(
            self,
            Self::IncreaseValence
                | Self::DecreaseValence
                | Self::IncreaseArousal
                | Self::DecreaseArousal
        )
    }

    pub fn marker_name(self) -> &'static str {
        match self {
            Self::IncreaseValence => "increase_valence",
            Self::DecreaseValence => "decrease_valence",
            Self::IncreaseArousal => "increase_arousal",
            Self::DecreaseArousal => "decrease_arousal",
            Self::Reset => "reset",
            Self::TogglePause => "toggle_pause",
            Self::ShowSettings => "show_settings",
            Self::ToggleOverlayEditing => "toggle_overlay_editing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputMode {
    Continuous,
    Step,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub current_x: f32,
    pub current_y: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub phase: f32,
    pub animation_active: bool,
    pub input_active: bool,
    pub radius: f32,
    pub angle_degrees: f32,
    pub overlay_visible: bool,
    pub overlay_editing: bool,
    pub overlay_opacity: f32,
    pub palette: AffectPalette,
    pub lsl_state: String,
    pub lsl_message: String,
}

#[derive(Debug)]
pub struct AffectEngine {
    current_x: f32,
    current_y: f32,
    target_x: f32,
    target_y: f32,
    phase: f32,
    animation_active: bool,
    held: HashSet<Action>,
    input_mode: InputMode,
    step_size: f32,
    continuous_speed: f32,
    response: f32,
    session_id: Uuid,
    sequence: u64,
}

impl AffectEngine {
    pub fn new(
        input_mode: InputMode,
        step_size: f32,
        continuous_speed: f32,
        response: f32,
    ) -> Self {
        Self {
            current_x: 0.0,
            current_y: 0.0,
            target_x: 0.0,
            target_y: 0.0,
            phase: 0.0,
            animation_active: true,
            held: HashSet::new(),
            input_mode,
            step_size,
            continuous_speed,
            response,
            session_id: Uuid::new_v4(),
            sequence: 0,
        }
    }

    pub fn configure(
        &mut self,
        input_mode: InputMode,
        step_size: f32,
        continuous_speed: f32,
        response: f32,
    ) {
        self.input_mode = input_mode;
        self.step_size = step_size;
        self.continuous_speed = continuous_speed;
        self.response = response;
        self.held.clear();
    }

    pub fn set_action(&mut self, action: Action, pressed: bool) {
        if !action.is_directional() {
            return;
        }
        match self.input_mode {
            InputMode::Step if pressed => self.apply_direction(action, self.step_size),
            InputMode::Step => {}
            InputMode::Continuous if pressed => {
                self.held.insert(action);
            }
            InputMode::Continuous => {
                self.held.remove(&action);
            }
        }
    }

    pub fn nudge(&mut self, action: Action) {
        if action.is_directional() {
            self.apply_direction(action, self.step_size);
        }
    }

    pub fn reset(&mut self) {
        self.target_x = 0.0;
        self.target_y = 0.0;
        self.held.clear();
    }

    pub fn set_target(&mut self, x: f32, y: f32) {
        self.target_x = x.clamp(-1.0, 1.0);
        self.target_y = y.clamp(-1.0, 1.0);
        self.held.clear();
    }

    pub fn toggle_pause(&mut self) {
        self.animation_active = !self.animation_active;
    }

    fn apply_direction(&mut self, action: Action, amount: f32) {
        match action {
            Action::IncreaseValence => self.target_x += amount,
            Action::DecreaseValence => self.target_x -= amount,
            Action::IncreaseArousal => self.target_y += amount,
            Action::DecreaseArousal => self.target_y -= amount,
            _ => {}
        }
        self.target_x = self.target_x.clamp(-1.0, 1.0);
        self.target_y = self.target_y.clamp(-1.0, 1.0);
    }

    pub fn tick(&mut self, delta_seconds: f32) {
        let dt = delta_seconds.clamp(0.0, 0.05);
        let horizontal = i8::from(self.held.contains(&Action::IncreaseValence))
            - i8::from(self.held.contains(&Action::DecreaseValence));
        let vertical = i8::from(self.held.contains(&Action::IncreaseArousal))
            - i8::from(self.held.contains(&Action::DecreaseArousal));
        self.target_x =
            (self.target_x + horizontal as f32 * self.continuous_speed * dt).clamp(-1.0, 1.0);
        self.target_y =
            (self.target_y + vertical as f32 * self.continuous_speed * dt).clamp(-1.0, 1.0);

        let smoothing = 1.0 - (-self.response * dt).exp();
        self.current_x =
            (self.current_x + (self.target_x - self.current_x) * smoothing).clamp(-1.0, 1.0);
        self.current_y =
            (self.current_y + (self.target_y - self.current_y) * smoothing).clamp(-1.0, 1.0);

        if self.animation_active {
            let frequency = 1.5 + self.current_y;
            self.phase = (self.phase + dt * std::f32::consts::TAU * frequency)
                .rem_euclid(std::f32::consts::TAU);
        }
        self.sequence = self.sequence.wrapping_add(1);
    }

    pub fn snapshot(
        &self,
        overlay_visible: bool,
        overlay_editing: bool,
        overlay_opacity: f32,
        palette: AffectPalette,
        lsl_state: &str,
        lsl_message: &str,
    ) -> AffectSnapshot {
        let radius = self.current_x.hypot(self.current_y).min(1.0);
        let angle_degrees = if self.current_x.abs() < 0.005 && self.current_y.abs() < 0.005 {
            0.0
        } else {
            (self.current_x.atan2(self.current_y) + std::f32::consts::PI)
                .rem_euclid(std::f32::consts::TAU)
                .to_degrees()
        };
        AffectSnapshot {
            session_id: self.session_id.to_string(),
            sequence: self.sequence,
            current_x: self.current_x,
            current_y: self.current_y,
            target_x: self.target_x,
            target_y: self.target_y,
            phase: self.phase,
            animation_active: self.animation_active,
            input_active: !self.held.is_empty(),
            radius,
            angle_degrees,
            overlay_visible,
            overlay_editing,
            overlay_opacity,
            palette,
            lsl_state: lsl_state.to_owned(),
            lsl_message: lsl_message.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> AffectEngine {
        AffectEngine::new(InputMode::Continuous, 0.1, 0.8, 8.0)
    }

    #[test]
    fn continuous_input_is_frame_rate_independent() {
        let mut fine = engine();
        fine.set_action(Action::IncreaseValence, true);
        for _ in 0..100 {
            fine.tick(0.01);
        }
        let mut coarse = engine();
        coarse.set_action(Action::IncreaseValence, true);
        for _ in 0..20 {
            coarse.tick(0.05);
        }
        assert!((fine.target_x - coarse.target_x).abs() < 0.0001);
    }

    #[test]
    fn opposite_actions_cancel() {
        let mut value = engine();
        value.set_action(Action::IncreaseValence, true);
        value.set_action(Action::DecreaseValence, true);
        value.tick(0.05);
        assert_eq!(value.target_x, 0.0);
    }

    #[test]
    fn nudge_and_reset_clamp_targets() {
        let mut value = engine();
        for _ in 0..30 {
            value.nudge(Action::IncreaseArousal);
        }
        assert_eq!(value.target_y, 1.0);
        value.reset();
        assert_eq!(value.target_y, 0.0);
    }

    #[test]
    fn reset_returns_smoothly_not_instantly() {
        let mut value = engine();
        value.nudge(Action::IncreaseValence);
        value.tick(0.05);
        let before = value.current_x;
        value.reset();
        assert_eq!(value.target_x, 0.0);
        assert_eq!(value.current_x, before);
        value.tick(0.05);
        assert!(value.current_x < before);
    }

    #[test]
    fn direct_target_selection_clamps_coordinates() {
        let mut value = engine();
        value.set_target(2.0, -3.0);
        assert_eq!(value.target_x, 1.0);
        assert_eq!(value.target_y, -1.0);
    }
}
