use crate::{CoreErrorCodeV1, CoreErrorV1, CoreResult};
use serde::{Deserialize, Serialize};

pub const STUDY_SCHEMA_V1: &str = "affect-tracker-study";
pub const RUN_CONFIGURATION_SCHEMA_V1: &str = "affect-tracker-run-configuration";
pub const RUN_STATE_SCHEMA_V1: &str = "affect-tracker-run-state";
pub const STUDY_ACTION_SCHEMA_V1: &str = "affect-tracker-study-action";
pub const RUN_EVENT_SCHEMA_V1: &str = "affect-tracker-run-event";
pub const RESULT_MANIFEST_SCHEMA_V1: &str = "affect-tracker-result-manifest";
pub const CONTRACT_VERSION_V1: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sha256HexV1(pub String);

impl Sha256HexV1 {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunSeedV1(pub String);

impl RunSeedV1 {
    pub fn bytes(&self) -> CoreResult<[u8; 16]> {
        if self.0.len() != 32
            || !self
                .0
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::InvalidValue,
                "runConfiguration.randomSeed",
                "must contain exactly 32 lowercase hexadecimal characters",
            ));
        }
        let mut bytes = [0_u8; 16];
        for (index, output) in bytes.iter_mut().enumerate() {
            let offset = index * 2;
            let chunk = &self.0.as_bytes()[offset..offset + 2];
            let text = std::str::from_utf8(chunk).map_err(|_| {
                CoreErrorV1::new(
                    CoreErrorCodeV1::InvalidValue,
                    "runConfiguration.randomSeed",
                    "must be valid ASCII hexadecimal",
                )
            })?;
            *output = u8::from_str_radix(text, 16).map_err(|_| {
                CoreErrorV1::new(
                    CoreErrorCodeV1::InvalidValue,
                    "runConfiguration.randomSeed",
                    "must be valid ASCII hexadecimal",
                )
            })?;
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BaseShapeV1 {
    Circle,
    Heart,
    Triangle,
    Square,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AxisPaletteV1 {
    pub up: String,
    pub down: String,
    pub left: String,
    pub right: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedVisualSettingsV1 {
    pub base_shape: BaseShapeV1,
    pub palette: AxisPaletteV1,
    pub animation_speed_multiplier: f64,
    pub pulse_amplitude_multiplier: f64,
    pub disorder_multiplier: f64,
    pub opacity: f64,
    pub widget_scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AffectResetPolicyV1 {
    NeutralAtRunStart,
    RequireCalibration,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionSettingsV1 {
    pub sample_rate_hz: u16,
    pub reset_policy: AffectResetPolicyV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedStudySettingsV1 {
    pub portable_settings_sha256: Sha256HexV1,
    pub acquisition: AcquisitionSettingsV1,
    pub visual: PinnedVisualSettingsV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformCapabilityV1 {
    AffectInput,
    ContentAddressedMedia,
    FlatVideo,
    Equirectangular180,
    Equirectangular360,
    SideBySideStereo,
    TopBottomStereo,
    Questionnaires,
    FaceFlubberComparison,
    YoutubeEmbed,
    ImmersivePanels,
    DurableJournal,
    Lsl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaProjectionV1 {
    Flat,
    Equirectangular180,
    Equirectangular360,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StereoLayoutV1 {
    Mono,
    SideBySideLeftRight,
    TopBottom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaClipV1 {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAssetV1 {
    pub asset_id: String,
    pub sha256: Sha256HexV1,
    pub byte_length: u64,
    pub mime_type: String,
    pub container: String,
    pub duration_ms: u64,
    pub has_audio: bool,
    pub projection: MediaProjectionV1,
    pub stereo_layout: StereoLayoutV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_clip: Option<MediaClipV1>,
    #[serde(default)]
    pub required_capabilities: Vec<PlatformCapabilityV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChoiceOptionV1 {
    pub option_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QuestionnaireItemV1 {
    Acknowledgement {
        item_id: String,
        prompt: String,
        required: bool,
    },
    SingleChoice {
        item_id: String,
        prompt: String,
        required: bool,
        options: Vec<ChoiceOptionV1>,
    },
    MultipleChoice {
        item_id: String,
        prompt: String,
        required: bool,
        min_selections: u16,
        max_selections: u16,
        options: Vec<ChoiceOptionV1>,
    },
    Likert {
        item_id: String,
        prompt: String,
        required: bool,
        min: i32,
        max: i32,
        min_label: String,
        max_label: String,
    },
    Vas {
        item_id: String,
        prompt: String,
        required: bool,
        min: f64,
        max: f64,
        step: f64,
        min_label: String,
        max_label: String,
    },
    Numeric {
        item_id: String,
        prompt: String,
        required: bool,
        min: f64,
        max: f64,
        step: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Affect2d {
        item_id: String,
        prompt: String,
        required: bool,
        step: f64,
    },
}

impl QuestionnaireItemV1 {
    #[must_use]
    pub fn item_id(&self) -> &str {
        match self {
            Self::Acknowledgement { item_id, .. }
            | Self::SingleChoice { item_id, .. }
            | Self::MultipleChoice { item_id, .. }
            | Self::Likert { item_id, .. }
            | Self::Vas { item_id, .. }
            | Self::Numeric { item_id, .. }
            | Self::Affect2d { item_id, .. } => item_id,
        }
    }

    #[must_use]
    pub fn required(&self) -> bool {
        match self {
            Self::Acknowledgement { required, .. }
            | Self::SingleChoice { required, .. }
            | Self::MultipleChoice { required, .. }
            | Self::Likert { required, .. }
            | Self::Vas { required, .. }
            | Self::Numeric { required, .. }
            | Self::Affect2d { required, .. } => *required,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionnaireV1 {
    pub questionnaire_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub items: Vec<QuestionnaireItemV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionPresentationV1 {
    Standard,
    /// Presentation-only comparison. Adapters must render Face and Flubber
    /// from the same current affect coordinates and animation phase.
    FaceFlubberComparison,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoPurposeV1 {
    Introduction,
    Practice,
    Stimulus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MediaSourceV1 {
    ContentAsset {
        asset_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip: Option<MediaClipV1>,
    },
    Youtube {
        video_id: String,
        start_ms: u64,
        end_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudyBlockV1 {
    Instruction {
        block_id: String,
        content: String,
        presentation: InstructionPresentationV1,
    },
    Video {
        block_id: String,
        purpose: VideoPurposeV1,
        source: MediaSourceV1,
        collect_affect: bool,
    },
    Questionnaire {
        block_id: String,
        questionnaire_id: String,
    },
    Break {
        block_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minimum_duration_ms: Option<u64>,
    },
    Completion {
        block_id: String,
        content: String,
    },
}

impl StudyBlockV1 {
    #[must_use]
    pub fn block_id(&self) -> &str {
        match self {
            Self::Instruction { block_id, .. }
            | Self::Video { block_id, .. }
            | Self::Questionnaire { block_id, .. }
            | Self::Break { block_id, .. }
            | Self::Completion { block_id, .. } => block_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum OrderPolicyV1 {
    Fixed,
    SeededShuffle,
    WilliamsBalancedLatinSquare,
}

/// Typed literal permitted on the equality side of a trial condition.
/// Multiple-choice conditions deliberately use membership instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrialConditionEqualityValueV1 {
    Acknowledgement { acknowledged: bool },
    SingleChoice { option_id: String },
    Likert { value: i32 },
    Vas { value: f64 },
    Numeric { value: f64 },
    Affect2d { valence: f64, arousal: f64 },
}

/// A single, non-composable condition controlling whether a trial runs.
///
/// The source is always one required item committed by a questionnaire block
/// in an earlier fixed section. There is intentionally no expression tree,
/// boolean composition, script, score, or navigation target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "operator",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrialRunConditionV1 {
    Equals {
        questionnaire_block_id: String,
        item_id: String,
        value: TrialConditionEqualityValueV1,
    },
    Contains {
        questionnaire_block_id: String,
        item_id: String,
        option_id: String,
    },
}

impl TrialRunConditionV1 {
    #[must_use]
    pub fn questionnaire_block_id(&self) -> &str {
        match self {
            Self::Equals {
                questionnaire_block_id,
                ..
            }
            | Self::Contains {
                questionnaire_block_id,
                ..
            } => questionnaire_block_id,
        }
    }

    #[must_use]
    pub fn item_id(&self) -> &str {
        match self {
            Self::Equals { item_id, .. } | Self::Contains { item_id, .. } => item_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyTrialV1 {
    pub trial_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_if: Option<TrialRunConditionV1>,
    pub blocks: Vec<StudyBlockV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudySectionV1 {
    pub section_id: String,
    pub title: String,
    pub order_policy: OrderPolicyV1,
    pub trials: Vec<StudyTrialV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionPolicyV1 {
    pub allow_early_stop: bool,
    pub require_completion_block: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyDefinitionV1 {
    pub schema: String,
    pub version: u16,
    pub study_id: String,
    pub revision: u32,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_hash: Option<Sha256HexV1>,
    pub pinned_settings: PinnedStudySettingsV1,
    #[serde(default)]
    pub required_capabilities: Vec<PlatformCapabilityV1>,
    #[serde(default)]
    pub media: Vec<MediaAssetV1>,
    #[serde(default)]
    pub questionnaires: Vec<QuestionnaireV1>,
    pub sections: Vec<StudySectionV1>,
    pub completion_policy: CompletionPolicyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformKindV1 {
    Desktop,
    Pages2d,
    WebXr,
    NativeQuest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatusV1 {
    Ready,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthComponentV1 {
    pub status: HealthStatusV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunHealthV1 {
    pub storage: HealthComponentV1,
    pub input: HealthComponentV1,
    pub lsl: HealthComponentV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCapabilitiesV1 {
    pub platform: PlatformKindV1,
    pub capabilities: Vec<PlatformCapabilityV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffectPointV1 {
    pub valence: f64,
    pub arousal: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunConfigurationV1 {
    pub schema: String,
    pub version: u16,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub random_seed: Option<RunSeedV1>,
    /// One-based Williams row selected by the researcher.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterbalance_group: Option<u16>,
    pub platform: PlatformCapabilitiesV1,
    pub initial_health: RunHealthV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedSectionOrderV1 {
    pub section_id: String,
    pub algorithm_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterbalance_group: Option<u16>,
    /// Digest of the complete Williams matrix for this section's trial count.
    /// Omitted for fixed and seeded-shuffle policies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matrix_sha256: Option<Sha256HexV1>,
    pub trial_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunPhaseV1 {
    Created,
    Prepared,
    Armed,
    Running,
    Paused,
    AwaitingFinalization,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaTimelineAnchorV1 {
    pub media_position_ms: u64,
    pub observed_monotonic_ms: u64,
    pub playing: bool,
    pub playback_rate: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StallKindV1 {
    Storage,
    Input,
    Media,
    Platform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStallV1 {
    pub kind: StallKindV1,
    pub code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalibrationMethodV1 {
    NeutralReset,
    ResearcherCalibration,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffectCalibrationV1 {
    pub point: AffectPointV1,
    pub method: CalibrationMethodV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionStatusV1 {
    Completed,
    StoppedEarly,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStateV1 {
    pub schema: String,
    pub version: u16,
    pub authority_generation: u64,
    pub revision: u64,
    pub run_id: String,
    pub protocol_hash: Sha256HexV1,
    pub phase: RunPhaseV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_section_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_trial_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_block_id: Option<String>,
    pub resolved_order: Vec<ResolvedSectionOrderV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_timeline_anchor: Option<MediaTimelineAnchorV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall: Option<RunStallV1>,
    pub health: RunHealthV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_settings_sha256: Option<Sha256HexV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affect_calibration: Option<AffectCalibrationV1>,
    pub completed_questionnaire_blocks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_status: Option<CompletionStatusV1>,
    pub last_event_sequence: u64,
    pub last_event_monotonic_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventClockV1 {
    pub monotonic_ms: u64,
    pub wall_time_utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionPreconditionV1 {
    pub expected_phase: RunPhaseV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_block_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QuestionnaireAnswerV1 {
    Acknowledgement {
        item_id: String,
        acknowledged: bool,
    },
    SingleChoice {
        item_id: String,
        option_id: String,
    },
    MultipleChoice {
        item_id: String,
        option_ids: Vec<String>,
    },
    Likert {
        item_id: String,
        value: i32,
    },
    Vas {
        item_id: String,
        value: f64,
    },
    Numeric {
        item_id: String,
        value: f64,
    },
    Affect2d {
        item_id: String,
        valence: f64,
        arousal: f64,
    },
}

impl QuestionnaireAnswerV1 {
    #[must_use]
    pub fn item_id(&self) -> &str {
        match self {
            Self::Acknowledgement { item_id, .. }
            | Self::SingleChoice { item_id, .. }
            | Self::MultipleChoice { item_id, .. }
            | Self::Likert { item_id, .. }
            | Self::Vas { item_id, .. }
            | Self::Numeric { item_id, .. }
            | Self::Affect2d { item_id, .. } => item_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffectSampleV1 {
    pub current_valence: f64,
    pub current_arousal: f64,
    pub target_valence: f64,
    pub target_arousal: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudyCommandV1 {
    Prepare,
    ApplyPinnedSettings {
        settings_sha256: Sha256HexV1,
    },
    SetAffectCalibration {
        point: AffectPointV1,
    },
    ResetAffect,
    Arm,
    Start,
    Pause {
        reason_code: String,
    },
    Resume,
    Advance,
    RetryBlock {
        reason_code: String,
    },
    SubmitQuestionnaire {
        questionnaire_id: String,
        answers: Vec<QuestionnaireAnswerV1>,
    },
    RecordAffectSample {
        sample: AffectSampleV1,
    },
    ReportMediaTimeline {
        anchor: MediaTimelineAnchorV1,
    },
    ReportHealth {
        health: RunHealthV1,
    },
    ReportStall {
        stall: RunStallV1,
    },
    ClearStall,
    Stop {
        reason_code: String,
    },
    Finalize,
    Abort {
        reason_code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyActionV1 {
    pub schema: String,
    pub version: u16,
    pub action_id: String,
    pub run_id: String,
    pub authority_generation: u64,
    pub expected_revision: u64,
    pub precondition: ActionPreconditionV1,
    pub clock: EventClockV1,
    pub command: StudyCommandV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RunEventPayloadV1 {
    Prepared,
    SettingsApplied {
        settings_sha256: Sha256HexV1,
    },
    AffectCalibrationSet {
        calibration: AffectCalibrationV1,
    },
    AffectReset {
        calibration: AffectCalibrationV1,
    },
    Armed,
    RunStarted,
    RunPaused {
        reason_code: String,
    },
    RunResumed,
    BlockEntered,
    BlockCompleted,
    BlockRetried {
        reason_code: String,
    },
    TrialBranchDecided {
        condition: TrialRunConditionV1,
        observed_answer: QuestionnaireAnswerV1,
        eligible: bool,
    },
    TrialSkipped {
        reason: TrialSkipReasonV1,
    },
    QuestionnaireSubmitted {
        questionnaire_id: String,
        answers: Vec<QuestionnaireAnswerV1>,
    },
    AffectSampleRecorded {
        sample: AffectSampleV1,
    },
    MediaTimelineUpdated {
        anchor: MediaTimelineAnchorV1,
    },
    HealthUpdated {
        health: RunHealthV1,
    },
    StallReported {
        stall: RunStallV1,
    },
    StallCleared,
    RunReadyToFinalize,
    RunStopped {
        reason_code: String,
    },
    RunFinalized,
    RunAborted {
        reason_code: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrialSkipReasonV1 {
    RunIfFalse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunEventV1 {
    pub schema: String,
    pub version: u16,
    pub sequence: u64,
    pub authority_generation: u64,
    pub revision: u64,
    pub action_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub monotonic_ms: u64,
    pub wall_time_utc: String,
    pub payload: RunEventPayloadV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReducerOutcomeV1 {
    pub state: RunStateV1,
    pub events: Vec<RunEventV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformBuildIdentityV1 {
    pub platform: PlatformKindV1,
    pub app_version: String,
    pub build_commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetVerificationV1 {
    pub asset_id: String,
    pub expected_sha256: Sha256HexV1,
    pub expected_byte_length: u64,
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_sha256: Option<Sha256HexV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_byte_length: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultManifestV1 {
    pub schema: String,
    pub version: u16,
    pub result_id: String,
    pub run_id: String,
    pub study_id: String,
    pub protocol_hash: Sha256HexV1,
    pub settings_sha256: Sha256HexV1,
    pub build: PlatformBuildIdentityV1,
    pub asset_verification: Vec<AssetVerificationV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub random_seed: Option<RunSeedV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterbalance_group: Option<u16>,
    pub resolved_order: Vec<ResolvedSectionOrderV1>,
    pub completion_status: CompletionStatusV1,
    pub event_count: u64,
    pub csv_sha256: Sha256HexV1,
    pub finalized_wall_time_utc: String,
}
