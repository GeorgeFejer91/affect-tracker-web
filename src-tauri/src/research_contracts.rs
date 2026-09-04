use crate::research_error::{CommandError, ResearchResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;
use url::Url;

pub const RESEARCH_SETTINGS_SCHEMA: &str = "affect-research-settings";
pub const RESOLVED_ASSIGNMENT_PLAN_SCHEMA: &str = "affect-research-assignment-plan";
pub const INPUT_BINDING_SCHEMA: &str = "affect-research-input-binding";
pub const RESEARCH_SAMPLE_SCHEMA: &str = "affect-research-sample";
pub const RESEARCH_EVENT_SCHEMA: &str = "affect-research-event";
pub const RESEARCH_RUN_MANIFEST_SCHEMA: &str = "affect-research-run-manifest";
pub const BALANCED_ALGORITHM_VERSION: &str = "balanced-v1";
pub const RESEARCH_NAMESPACE: &str = "affect-research/v1";
pub const MAX_PARTICIPANTS: usize = 100_000;
pub const MAX_STIMULI: usize = 10_000;
pub const MAX_POOLS: usize = 256;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchSettingsV1 {
    pub schema: String,
    pub version: u32,
    pub experiment: ExperimentSettingsV1,
    pub stimuli: StimuliSettingsV1,
    pub input: InputBindingV1,
    pub visual: VisualSettingsV1,
    pub advanced: AdvancedSettingsV1,
    pub output: OutputSettingsV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentSettingsV1 {
    pub id: String,
    pub title: String,
    pub participant_count: u32,
    pub sampling_frequency_hz: u16,
    pub between_videos: BetweenVideosV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BetweenVideosV1 {
    Fixed { duration_ms: u32 },
    Jitter { durations_ms: Vec<u32> },
    ContinueWhenReady,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StimuliSettingsV1 {
    pub allocation_algorithm: AllocationAlgorithmV1,
    pub condition_order: ConditionOrderV1,
    pub seed: String,
    pub items: Vec<StimulusV1>,
    pub pools: Vec<StimulusPoolV1>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AllocationAlgorithmV1 {
    #[serde(rename = "balanced-v1")]
    BalancedV1,
}

impl AllocationAlgorithmV1 {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BalancedV1 => BALANCED_ALGORITHM_VERSION,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConditionOrderV1 {
    Williams,
    Cyclic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StimulusV1 {
    pub stimulus_id: String,
    pub title: String,
    pub source: StimulusSourceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StimulusSourceV1 {
    WorkspaceFile {
        relative_path: String,
        mime_type: String,
        sha256: String,
        byte_length: u64,
        duration_ms: f64,
    },
    RepositoryAsset {
        relative_path: String,
        mime_type: String,
        sha256: String,
        byte_length: u64,
        duration_ms: f64,
    },
    Youtube {
        url: String,
        video_id: String,
        observed_title: Option<String>,
        observed_duration_ms: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StimulusPoolV1 {
    pub pool_id: String,
    pub label: String,
    pub videos_per_participant: u32,
    pub stimulus_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputBindingV1 {
    pub schema: String,
    pub version: u32,
    pub preset: InputPresetV1,
    pub kind: InputKindV1,
    pub step_size: Option<f64>,
    pub directions: Option<DigitalDirectionsV1>,
    pub axes: Option<InputAxesV1>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InputPresetV1 {
    ArrowKeys,
    Wasd,
    Ijkl,
    Numpad,
    PointerGrid,
    MouseButtonsWheel,
    GamepadDpad,
    GamepadLeftStick,
    GamepadRightStick,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InputKindV1 {
    Digital,
    Absolute,
    Analog,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigitalDirectionsV1 {
    pub up: DigitalInputTokenV1,
    pub down: DigitalInputTokenV1,
    pub left: DigitalInputTokenV1,
    pub right: DigitalInputTokenV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DigitalInputTokenV1 {
    Keyboard { code: String },
    MouseButton { button: u8 },
    Wheel { direction: DirectionV1 },
    GamepadButton { button: u8 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum DirectionV1 {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputAxesV1 {
    pub x: AxisInputTokenV1,
    pub y: AxisInputTokenV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AxisInputTokenV1 {
    PointerAxis { axis: AxisNameV1, invert: bool },
    GamepadAxis { index: u8, invert: bool },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AxisNameV1 {
    X,
    Y,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualSettingsV1 {
    pub grid_enabled: bool,
    pub flubber_enabled: bool,
    pub size_percent: f64,
    pub transparency: f64,
    pub hide_feedback: bool,
    pub overlay_position: OverlayPositionV1,
    pub lock_position: bool,
    pub flubber: FlubberAppearanceV1,
    pub grid: GridAppearanceV1,
    pub colors: ResearchColorsV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayPositionV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlubberAppearanceV1 {
    pub show_outline: bool,
    pub outline_thickness: f64,
    pub show_halo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridAppearanceV1 {
    pub line_thickness: f64,
    pub show_outline: bool,
    pub outline_thickness: f64,
    pub cursor_size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchColorsV1 {
    pub up: String,
    pub down: String,
    pub left: String,
    pub right: String,
    pub idle: String,
    pub outline: String,
    pub halo: String,
    pub cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvancedSettingsV1 {
    pub lsl: ResearchLslSettingsV1,
    pub mappings: FlubberMappingsV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchLslSettingsV1 {
    pub enabled: bool,
    pub state_stream: String,
    pub stream_type: String,
    pub marker_stream: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlubberMappingsV1 {
    pub oscillation_frequency: FlubberMappingV1,
    pub edge_smoothness: FlubberMappingV1,
    pub projection_amplitude: FlubberMappingV1,
    pub pulse_synchrony: FlubberMappingV1,
    pub wave_size_variation: FlubberMappingV1,
    pub saturation: FlubberMappingV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlubberMappingV1 {
    pub min: f64,
    pub max: f64,
    pub driven_by: MappingDriverV1,
    pub reverse: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MappingDriverV1 {
    #[serde(rename = "x-axis")]
    XAxis,
    #[serde(rename = "y-axis")]
    YAxis,
    #[serde(rename = "angle")]
    Angle,
    #[serde(rename = "radius")]
    Radius,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputSettingsV1 {
    pub csv: bool,
    pub tsv: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedAssignmentPlanV1 {
    pub schema: String,
    pub version: u32,
    pub algorithm_version: AllocationAlgorithmV1,
    pub seed: String,
    pub condition_order: ConditionOrderV1,
    pub settings_sha256: String,
    pub participant_ids: Vec<String>,
    pub stimuli: Vec<StimulusV1>,
    pub pools: Vec<StimulusPoolV1>,
    pub assignments: Vec<ParticipantAssignmentV1>,
    pub exposure_counts: Vec<StimulusExposureV1>,
    pub plan_hash_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParticipantAssignmentV1 {
    pub participant_id: String,
    pub condition_order: Vec<String>,
    pub slots: Vec<AssignmentSlotV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentSlotV1 {
    pub position: u32,
    pub pool_id: String,
    pub pool_position: u32,
    pub stimulus_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StimulusExposureV1 {
    pub stimulus_id: String,
    pub total: u32,
    pub position_counts: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleStimulusIdentityV1 {
    pub kind: StimulusSourceKindV1,
    pub stimulus_id: String,
    pub sha256: Option<String>,
    pub byte_length: Option<u64>,
    pub duration_ms: f64,
    pub url: Option<String>,
    pub video_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StimulusSourceKindV1 {
    WorkspaceFile,
    RepositoryAsset,
    Youtube,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchSampleV1 {
    pub schema: String,
    pub version: u32,
    pub sequence: u64,
    pub run_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub settings_sha256: String,
    pub assignment_plan_sha256: String,
    pub stimulus_position: u32,
    pub stimulus_identity: SampleStimulusIdentityV1,
    pub wall_time_utc: String,
    pub monotonic_time_ns: String,
    pub lsl_time_seconds: Option<f64>,
    pub sample_rate_hz: u16,
    pub scheduled_elapsed_ms: f64,
    pub observed_elapsed_ms: f64,
    pub scheduler_lateness_ms: f64,
    pub scheduler_jitter_ms: f64,
    pub state_anchor_age_ms: f64,
    pub missed_slots_before: u64,
    pub media_time_ms: f64,
    pub current_valence: f64,
    pub current_arousal: f64,
    pub target_valence: f64,
    pub target_arousal: f64,
    pub radius: f64,
    pub angle_degrees: f64,
    pub oscillation_frequency: f64,
    pub edge_smoothness: f64,
    pub projection_amplitude: f64,
    pub pulse_synchrony: f64,
    pub wave_size_variation: f64,
    pub saturation: f64,
    pub animation_active: bool,
    pub input_active: bool,
    pub input_kind: InputKindV1,
    pub feedback_visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResearchEventTypeV1 {
    SessionPrepared,
    SessionStarted,
    StimulusStarted,
    StimulusPaused,
    StimulusResumed,
    StimulusCompleted,
    TransitionStarted,
    TransitionCompleted,
    InputEdge,
    TimingGap,
    WriteInterrupted,
    WriteRecovered,
    RecoveryStarted,
    RecoveryCompleted,
    StoppedEarly,
    SessionCompleted,
    SessionAborted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchEventV1 {
    pub schema: String,
    pub version: u32,
    pub sequence: u64,
    pub run_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub settings_sha256: String,
    pub assignment_plan_sha256: String,
    pub wall_time_utc: String,
    pub monotonic_time_ns: String,
    #[serde(rename = "type")]
    pub event_type: ResearchEventTypeV1,
    pub stimulus_identity: Option<SampleStimulusIdentityV1>,
    pub stimulus_position: Option<u32>,
    pub media_time_ms: Option<f64>,
    pub missed_slot_count: Option<u64>,
    pub detail_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchRunManifestV2 {
    pub schema: String,
    pub version: u32,
    pub run_id: String,
    pub experiment_id: String,
    pub participant_id: String,
    pub participant_code: String,
    pub age: u8,
    pub gender: GenderCodeV1,
    pub handedness: HandednessCodeV1,
    pub attempt_number: u32,
    pub session_stem: String,
    pub completion_status: CompletionStatusV1,
    pub settings_sha256: String,
    pub assignment_plan_sha256: String,
    pub stimuli: Vec<SampleStimulusIdentityV1>,
    pub timing: RunTimingV1,
    pub outputs: Vec<RunOutputV1>,
    pub recovery: RecoverySummaryV1,
    pub build: ResearchBuildV1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GenderCodeV1 {
    W,
    M,
    N,
    S,
    X,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum HandednessCodeV1 {
    L,
    R,
    A,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CompletionStatusV1 {
    Completed,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTimingV1 {
    pub sample_rate_hz: u16,
    pub sample_count: u64,
    pub event_count: u64,
    pub gap_event_count: u64,
    pub missed_slot_count: u64,
    pub started_at: String,
    pub finalized_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunOutputV1 {
    pub kind: RunOutputKindV1,
    pub file_name: String,
    pub sha256: String,
    pub byte_length: u64,
    pub row_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RunOutputKindV1 {
    Settings,
    Events,
    Csv,
    Tsv,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverySummaryV1 {
    pub resumed: bool,
    pub source_run_id: Option<String>,
    pub restarted_stimulus_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchBuildV1 {
    pub platform: ResearchPlatformV1,
    pub app_version: String,
    pub build_commit: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResearchPlatformV1 {
    TauriWindows,
    Chrome,
    Edge,
}

impl ResearchSettingsV1 {
    pub fn normalize_and_validate(mut self) -> ResearchResult<Self> {
        if self.schema != RESEARCH_SETTINGS_SCHEMA || self.version != 1 {
            return Err(contract_error(
                "ResearchSettingsV1 schema or version is unsupported.",
            ));
        }
        self.experiment.id = normalize_identifier(&self.experiment.id, "experiment.id")?;
        self.experiment.title = normalize_text(&self.experiment.title, 1, 160, "experiment.title")?;
        if self.experiment.participant_count == 0
            || self.experiment.participant_count as usize > MAX_PARTICIPANTS
        {
            return Err(contract_error("participantCount must be within 1–100000."));
        }
        if !(1..=240).contains(&self.experiment.sampling_frequency_hz) {
            return Err(contract_error("samplingFrequencyHz must be within 1–240."));
        }
        validate_transition(&self.experiment.between_videos)?;
        if self.stimuli.seed.len() != 32 || !is_lower_hex(&self.stimuli.seed) {
            return Err(contract_error(
                "The allocation seed must be 128-bit lowercase hexadecimal.",
            ));
        }
        if self.stimuli.items.len() > MAX_STIMULI || self.stimuli.pools.len() > MAX_POOLS {
            return Err(contract_error(
                "The stimulus or pool count exceeds the Research v1 bound.",
            ));
        }
        for stimulus in &mut self.stimuli.items {
            stimulus.normalize_and_validate()?;
        }
        self.stimuli
            .items
            .sort_by(|left, right| left.stimulus_id.cmp(&right.stimulus_id));
        ensure_unique(
            self.stimuli
                .items
                .iter()
                .map(|item| item.stimulus_id.as_str()),
            "Stimulus IDs must be unique.",
        )?;
        let mut local_digests = HashSet::new();
        let mut youtube_video_ids = HashSet::new();
        for stimulus in &self.stimuli.items {
            let unique = match &stimulus.source {
                StimulusSourceV1::WorkspaceFile { sha256, .. }
                | StimulusSourceV1::RepositoryAsset { sha256, .. } => {
                    local_digests.insert(sha256.as_str())
                }
                StimulusSourceV1::Youtube { video_id, .. } => {
                    youtube_video_ids.insert(video_id.as_str())
                }
            };
            if !unique {
                return Err(contract_error(
                    "The same physical stimulus cannot appear under multiple stimulus IDs.",
                ));
            }
        }
        let item_ids: HashSet<String> = self
            .stimuli
            .items
            .iter()
            .map(|item| item.stimulus_id.clone())
            .collect();
        for pool in &mut self.stimuli.pools {
            pool.normalize_and_validate()?;
        }
        ensure_unique(
            self.stimuli.pools.iter().map(|pool| pool.pool_id.as_str()),
            "Pool IDs must be unique.",
        )?;
        let mut memberships = HashSet::new();
        for pool in &self.stimuli.pools {
            for stimulus_id in &pool.stimulus_ids {
                if !item_ids.contains(stimulus_id) {
                    return Err(contract_error("A pool references an unknown stimulus."));
                }
                if !memberships.insert(stimulus_id.clone()) {
                    return Err(contract_error("A stimulus may belong to only one pool."));
                }
            }
        }
        if (!self.stimuli.items.is_empty() || !self.stimuli.pools.is_empty())
            && memberships.len() != item_ids.len()
        {
            return Err(contract_error(
                "Every stimulus must belong to exactly one pool.",
            ));
        }
        self.input.normalize_and_validate()?;
        self.visual.normalize_and_validate()?;
        self.advanced.normalize_and_validate()?;
        if !self.output.csv && !self.output.tsv {
            return Err(contract_error(
                "At least one of CSV or TSV must be enabled.",
            ));
        }
        Ok(self)
    }

    pub fn canonical_sha256(&self) -> ResearchResult<String> {
        canonical_sha256(self, &[])
    }
}

impl StimulusV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        self.stimulus_id = normalize_identifier(&self.stimulus_id, "stimulusId")?;
        self.title = normalize_text(&self.title, 1, 200, "stimulus.title")?;
        self.source.normalize_and_validate()
    }

    pub fn sample_identity(&self) -> SampleStimulusIdentityV1 {
        match &self.source {
            StimulusSourceV1::WorkspaceFile {
                sha256,
                byte_length,
                duration_ms,
                ..
            } => SampleStimulusIdentityV1 {
                kind: StimulusSourceKindV1::WorkspaceFile,
                stimulus_id: self.stimulus_id.clone(),
                sha256: Some(sha256.clone()),
                byte_length: Some(*byte_length),
                duration_ms: *duration_ms,
                url: None,
                video_id: None,
            },
            StimulusSourceV1::RepositoryAsset {
                sha256,
                byte_length,
                duration_ms,
                ..
            } => SampleStimulusIdentityV1 {
                kind: StimulusSourceKindV1::RepositoryAsset,
                stimulus_id: self.stimulus_id.clone(),
                sha256: Some(sha256.clone()),
                byte_length: Some(*byte_length),
                duration_ms: *duration_ms,
                url: None,
                video_id: None,
            },
            StimulusSourceV1::Youtube {
                url,
                video_id,
                observed_duration_ms,
                ..
            } => SampleStimulusIdentityV1 {
                kind: StimulusSourceKindV1::Youtube,
                stimulus_id: self.stimulus_id.clone(),
                sha256: None,
                byte_length: None,
                duration_ms: observed_duration_ms.unwrap_or(1.0),
                url: Some(url.clone()),
                video_id: Some(video_id.clone()),
            },
        }
    }
}

impl StimulusSourceV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        match self {
            Self::WorkspaceFile {
                relative_path,
                mime_type,
                sha256,
                byte_length,
                duration_ms,
            } => {
                *relative_path = normalize_relative_path(relative_path, Some("stimuli"))?;
                validate_local_source(mime_type, sha256, *byte_length, duration_ms)
            }
            Self::RepositoryAsset {
                relative_path,
                mime_type,
                sha256,
                byte_length,
                duration_ms,
            } => {
                *relative_path = normalize_relative_path(relative_path, None)?;
                validate_local_source(mime_type, sha256, *byte_length, duration_ms)
            }
            Self::Youtube {
                url,
                video_id,
                observed_title,
                observed_duration_ms,
            } => {
                let parsed = Url::parse(url).map_err(|_| {
                    contract_error("Experimental YouTube sources require an absolute HTTPS URL.")
                })?;
                if parsed.scheme() != "https" || !is_youtube_host(parsed.host_str()) {
                    return Err(contract_error(
                        "Experimental YouTube sources require an HTTPS YouTube URL.",
                    ));
                }
                *url = parsed.to_string();
                *video_id = normalize_text(video_id, 6, 32, "youtube.videoId")?;
                if let Some(title) = observed_title {
                    *title = normalize_text(title, 1, 200, "youtube.observedTitle")?;
                }
                if let Some(duration) = observed_duration_ms {
                    validate_finite_range(*duration, 1.0, 86_400_000.0, "youtube duration")?;
                    *duration = normalize_zero(*duration);
                }
                Ok(())
            }
        }
    }
}

impl StimulusPoolV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        self.pool_id = normalize_identifier(&self.pool_id, "poolId")?;
        self.label = normalize_text(&self.label, 1, 120, "pool.label")?;
        if self.videos_per_participant == 0
            || self.videos_per_participant as usize > MAX_STIMULI
            || self.stimulus_ids.is_empty()
            || self.stimulus_ids.len() > MAX_STIMULI
        {
            return Err(contract_error(
                "Pool counts must be within the Research v1 bounds.",
            ));
        }
        for stimulus_id in &mut self.stimulus_ids {
            *stimulus_id = normalize_identifier(stimulus_id, "pool.stimulusId")?;
        }
        self.stimulus_ids.sort();
        ensure_unique(
            self.stimulus_ids.iter().map(String::as_str),
            "A pool contains duplicate stimulus IDs.",
        )
    }
}

impl InputBindingV1 {
    pub fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        if self.schema != INPUT_BINDING_SCHEMA || self.version != 1 {
            return Err(contract_error(
                "InputBindingV1 schema or version is unsupported.",
            ));
        }
        match self.kind {
            InputKindV1::Digital => {
                let step_size = self
                    .step_size
                    .ok_or_else(|| contract_error("Digital input requires Step Size."))?;
                validate_finite_range(step_size, 0.001, 1.0, "stepSize")?;
                self.step_size = Some(normalize_zero(step_size));
                if self.axes.is_some() {
                    return Err(contract_error(
                        "Digital input cannot define continuous axes.",
                    ));
                }
                let directions = self
                    .directions
                    .as_mut()
                    .ok_or_else(|| contract_error("Digital input requires four directions."))?;
                directions.normalize_and_validate()?;
            }
            InputKindV1::Absolute | InputKindV1::Analog => {
                if self.step_size.is_some() || self.directions.is_some() {
                    return Err(contract_error(
                        "Absolute and analog input use N/A Step Size and no digital directions.",
                    ));
                }
                let axes = self
                    .axes
                    .as_ref()
                    .ok_or_else(|| contract_error("Absolute and analog input require x/y axes."))?;
                axes.validate(self.kind)?;
            }
        }
        validate_preset_payload(self)
    }
}

impl DigitalDirectionsV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        for token in [
            &mut self.up,
            &mut self.down,
            &mut self.left,
            &mut self.right,
        ] {
            token.normalize_and_validate()?;
        }
        let signatures: HashSet<String> = [&self.up, &self.down, &self.left, &self.right]
            .into_iter()
            .map(DigitalInputTokenV1::signature)
            .collect();
        if signatures.len() != 4 {
            return Err(contract_error(
                "Every digital direction must use a unique physical action.",
            ));
        }
        Ok(())
    }

    pub fn direction_for(&self, token: &DigitalInputTokenV1) -> Option<DirectionV1> {
        [
            (DirectionV1::Up, &self.up),
            (DirectionV1::Down, &self.down),
            (DirectionV1::Left, &self.left),
            (DirectionV1::Right, &self.right),
        ]
        .into_iter()
        .find_map(|(direction, candidate)| (candidate == token).then_some(direction))
    }
}

impl DigitalInputTokenV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        match self {
            Self::Keyboard { code } => {
                *code = normalize_text(code, 1, 40, "keyboard code")?;
                if !code
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
                {
                    return Err(contract_error(
                        "Keyboard codes must be physical alphanumeric KeyboardEvent codes.",
                    ));
                }
            }
            Self::MouseButton { button } if *button > 31 => {
                return Err(contract_error("Mouse button indices must be within 0–31."));
            }
            Self::GamepadButton { button } if *button > 63 => {
                return Err(contract_error(
                    "Gamepad button indices must be within 0–63.",
                ));
            }
            Self::Wheel { .. } | Self::MouseButton { .. } | Self::GamepadButton { .. } => {}
        }
        Ok(())
    }

    pub fn signature(&self) -> String {
        match self {
            Self::Keyboard { code } => format!("keyboard:{}", code.to_ascii_lowercase()),
            Self::MouseButton { button } => format!("mouseButton:{button}"),
            Self::Wheel { direction } => format!("wheel:{direction:?}").to_ascii_lowercase(),
            Self::GamepadButton { button } => format!("gamepadButton:{button}"),
        }
    }

    pub fn detail_code(&self) -> String {
        self.signature()
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':') {
                    character.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .take(128)
            .collect()
    }
}

impl InputAxesV1 {
    fn validate(&self, kind: InputKindV1) -> ResearchResult<()> {
        match kind {
            InputKindV1::Absolute => {
                if !matches!(self.x, AxisInputTokenV1::PointerAxis { .. })
                    || !matches!(self.y, AxisInputTokenV1::PointerAxis { .. })
                {
                    return Err(contract_error("Absolute input requires pointer axes."));
                }
            }
            InputKindV1::Analog => {
                if !matches!(self.x, AxisInputTokenV1::GamepadAxis { .. })
                    || !matches!(self.y, AxisInputTokenV1::GamepadAxis { .. })
                {
                    return Err(contract_error("Analog input requires gamepad axes."));
                }
            }
            InputKindV1::Digital => {
                return Err(contract_error("Digital input cannot define axes."))
            }
        }
        match (&self.x, &self.y) {
            (
                AxisInputTokenV1::PointerAxis { axis: left, .. },
                AxisInputTokenV1::PointerAxis { axis: right, .. },
            ) if left == right => Err(contract_error("Input axes must be unique.")),
            (
                AxisInputTokenV1::GamepadAxis { index: left, .. },
                AxisInputTokenV1::GamepadAxis { index: right, .. },
            ) if left == right => Err(contract_error("Input axes must be unique.")),
            (AxisInputTokenV1::GamepadAxis { index, .. }, _) if *index > 15 => {
                Err(contract_error("Gamepad axis indices must be within 0–15."))
            }
            (_, AxisInputTokenV1::GamepadAxis { index, .. }) if *index > 15 => {
                Err(contract_error("Gamepad axis indices must be within 0–15."))
            }
            _ => Ok(()),
        }
    }
}

impl VisualSettingsV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        self.size_percent = validated_number(self.size_percent, 5.0, 100.0, "visual.sizePercent")?;
        self.transparency = validated_number(self.transparency, 0.0, 1.0, "visual.transparency")?;
        self.overlay_position.x =
            validated_number(self.overlay_position.x, 0.0, 1.0, "overlayPosition.x")?;
        self.overlay_position.y =
            validated_number(self.overlay_position.y, 0.0, 1.0, "overlayPosition.y")?;
        self.flubber.outline_thickness = validated_number(
            self.flubber.outline_thickness,
            0.0,
            20.0,
            "flubber.outlineThickness",
        )?;
        self.grid.line_thickness =
            validated_number(self.grid.line_thickness, 0.25, 20.0, "grid.lineThickness")?;
        self.grid.outline_thickness = validated_number(
            self.grid.outline_thickness,
            0.0,
            20.0,
            "grid.outlineThickness",
        )?;
        self.grid.cursor_size =
            validated_number(self.grid.cursor_size, 2.0, 100.0, "grid.cursorSize")?;
        for color in [
            &mut self.colors.up,
            &mut self.colors.down,
            &mut self.colors.left,
            &mut self.colors.right,
            &mut self.colors.idle,
            &mut self.colors.outline,
            &mut self.colors.halo,
            &mut self.colors.cursor,
        ] {
            if !is_hex_color(color) {
                return Err(contract_error(
                    "Research colors must use six-digit hexadecimal notation.",
                ));
            }
            color.make_ascii_lowercase();
        }
        Ok(())
    }
}

impl AdvancedSettingsV1 {
    fn normalize_and_validate(&mut self) -> ResearchResult<()> {
        self.lsl.state_stream = normalize_text(&self.lsl.state_stream, 1, 80, "lsl.stateStream")?;
        self.lsl.stream_type = normalize_text(&self.lsl.stream_type, 1, 80, "lsl.streamType")?;
        self.lsl.marker_stream =
            normalize_text(&self.lsl.marker_stream, 1, 80, "lsl.markerStream")?;
        self.lsl.source_id = normalize_text(&self.lsl.source_id, 1, 120, "lsl.sourceId")?;
        self.mappings.oscillation_frequency.normalize_and_validate(
            0.0,
            10.0,
            "Oscillation Frequency",
        )?;
        self.mappings
            .edge_smoothness
            .normalize_and_validate(0.0, 1.0, "Edge Smoothness")?;
        self.mappings.projection_amplitude.normalize_and_validate(
            0.0,
            1.0,
            "Projection Amplitude",
        )?;
        self.mappings
            .pulse_synchrony
            .normalize_and_validate(0.0, 1.0, "Pulse Synchrony")?;
        self.mappings.wave_size_variation.normalize_and_validate(
            0.0,
            1.0,
            "Wave-size Variation",
        )?;
        self.mappings
            .saturation
            .normalize_and_validate(0.0, 1.0, "Saturation")
    }
}

impl FlubberMappingV1 {
    fn normalize_and_validate(
        &mut self,
        allowed_min: f64,
        allowed_max: f64,
        label: &str,
    ) -> ResearchResult<()> {
        self.min = validated_number(self.min, allowed_min, allowed_max, label)?;
        self.max = validated_number(self.max, allowed_min, allowed_max, label)?;
        if self.min > self.max {
            return Err(contract_error(format!(
                "{label} minimum must not exceed its maximum."
            )));
        }
        Ok(())
    }

    pub fn evaluate(&self, x: f64, y: f64) -> f64 {
        let bounded_x = x.clamp(-1.0, 1.0);
        let bounded_y = y.clamp(-1.0, 1.0);
        let raw_radius = bounded_x.hypot(bounded_y);
        let radius = raw_radius.clamp(0.0, 1.0);
        let angle = if raw_radius == 0.0 {
            0.0
        } else {
            bounded_y.atan2(bounded_x).to_degrees().rem_euclid(360.0)
        };
        let raw_t = match self.driven_by {
            MappingDriverV1::XAxis => (bounded_x + 1.0) / 2.0,
            MappingDriverV1::YAxis => (bounded_y + 1.0) / 2.0,
            MappingDriverV1::Angle => angle / 360.0,
            MappingDriverV1::Radius => radius,
        };
        let t = if self.reverse { 1.0 - raw_t } else { raw_t };
        self.min + (self.max - self.min) * t
    }
}

impl ResolvedAssignmentPlanV1 {
    pub fn validate(&self, expected_settings_hash: &str) -> ResearchResult<()> {
        if self.schema != RESOLVED_ASSIGNMENT_PLAN_SCHEMA
            || self.version != 1
            || self.algorithm_version.as_str() != BALANCED_ALGORITHM_VERSION
        {
            return Err(contract_error(
                "ResolvedAssignmentPlanV1 schema, version, or algorithm is unsupported.",
            ));
        }
        validate_sha256(&self.settings_sha256, "settingsSha256")?;
        if self.settings_sha256 != expected_settings_hash {
            return Err(contract_error(
                "The assignment plan does not bind the normalized settings.",
            ));
        }
        validate_sha256(&self.plan_hash_sha256, "planHashSha256")?;
        if self.seed.len() != 32 || !is_lower_hex(&self.seed) {
            return Err(contract_error("The assignment plan seed is invalid."));
        }
        if self.participant_ids.is_empty() || self.participant_ids.len() > MAX_PARTICIPANTS {
            return Err(contract_error(
                "The assignment plan participant count is invalid.",
            ));
        }
        ensure_unique(
            self.participant_ids.iter().map(String::as_str),
            "The assignment plan contains duplicate participants.",
        )?;
        for participant_id in &self.participant_ids {
            validate_participant_id(participant_id)?;
        }
        let participant_width = self.participant_ids.len().to_string().len().max(3);
        for (index, participant_id) in self.participant_ids.iter().enumerate() {
            if participant_id != &format!("P{:0participant_width$}", index + 1) {
                return Err(contract_error(
                    "Assignment participants must use the canonical generated order.",
                ));
            }
        }
        if self.stimuli.is_empty() || self.stimuli.len() > MAX_STIMULI {
            return Err(contract_error(
                "The assignment plan stimulus count is invalid.",
            ));
        }
        let stimulus_ids: HashSet<&str> = self
            .stimuli
            .iter()
            .map(|item| item.stimulus_id.as_str())
            .collect();
        if stimulus_ids.len() != self.stimuli.len() {
            return Err(contract_error(
                "The assignment plan contains duplicate stimuli.",
            ));
        }
        let pool_by_id: HashMap<&str, &StimulusPoolV1> = self
            .pools
            .iter()
            .map(|pool| (pool.pool_id.as_str(), pool))
            .collect();
        if pool_by_id.len() != self.pools.len()
            || self.pools.is_empty()
            || self.pools.len() > MAX_POOLS
        {
            return Err(contract_error("The assignment plan pools are invalid."));
        }
        let mut planned_memberships = HashSet::new();
        for pool in &self.pools {
            if pool.videos_per_participant == 0
                || pool.videos_per_participant as usize > pool.stimulus_ids.len()
            {
                return Err(contract_error(
                    "An assignment pool cannot request more unique videos than it contains.",
                ));
            }
            for stimulus_id in &pool.stimulus_ids {
                if !stimulus_ids.contains(stimulus_id.as_str())
                    || !planned_memberships.insert(stimulus_id.as_str())
                {
                    return Err(contract_error(
                        "The assignment plan has an invalid pool membership.",
                    ));
                }
            }
        }
        if planned_memberships.len() != stimulus_ids.len() {
            return Err(contract_error(
                "The assignment plan must pool every stimulus exactly once.",
            ));
        }
        let total_slots: usize = self
            .pools
            .iter()
            .map(|pool| pool.videos_per_participant as usize)
            .sum();
        let mut computed_totals: HashMap<&str, u32> =
            stimulus_ids.iter().map(|id| (*id, 0)).collect();
        let mut computed_positions: HashMap<&str, Vec<u32>> = stimulus_ids
            .iter()
            .map(|id| (*id, vec![0; total_slots]))
            .collect();
        if self.assignments.len() != self.participant_ids.len() {
            return Err(contract_error(
                "The assignment plan must contain one assignment per participant.",
            ));
        }
        let mut assigned_participants = HashSet::new();
        let condition_rows = expected_condition_rows(self.condition_order, self.pools.len());
        for (assignment_index, assignment) in self.assignments.iter().enumerate() {
            if !self.participant_ids.contains(&assignment.participant_id)
                || !assigned_participants.insert(assignment.participant_id.as_str())
                || assignment.participant_id != self.participant_ids[assignment_index]
                || assignment.slots.len() != total_slots
                || assignment.condition_order.len() != self.pools.len()
            {
                return Err(contract_error("A participant assignment is invalid."));
            }
            let condition_set: HashSet<&str> = assignment
                .condition_order
                .iter()
                .map(String::as_str)
                .collect();
            if condition_set.len() != self.pools.len()
                || condition_set
                    .iter()
                    .any(|pool_id| !pool_by_id.contains_key(pool_id))
            {
                return Err(contract_error("A participant condition order is invalid."));
            }
            let expected_order = condition_rows[assignment_index % condition_rows.len()]
                .iter()
                .map(|index| self.pools[*index].pool_id.as_str())
                .collect::<Vec<_>>();
            if assignment
                .condition_order
                .iter()
                .map(String::as_str)
                .ne(expected_order)
            {
                return Err(contract_error(
                    "A participant does not follow the declared condition-order algorithm.",
                ));
            }
            let mut seen_stimuli = HashSet::new();
            let mut per_pool: HashMap<&str, u32> =
                pool_by_id.keys().map(|pool_id| (*pool_id, 0)).collect();
            for (index, slot) in assignment.slots.iter().enumerate() {
                let Some(pool) = pool_by_id.get(slot.pool_id.as_str()) else {
                    return Err(contract_error(
                        "An assignment slot references an unknown pool.",
                    ));
                };
                let expected_pool_position =
                    per_pool.get(slot.pool_id.as_str()).copied().unwrap_or(0) + 1;
                if slot.position as usize != index + 1
                    || slot.pool_position != expected_pool_position
                    || !pool.stimulus_ids.contains(&slot.stimulus_id)
                    || !seen_stimuli.insert(slot.stimulus_id.as_str())
                {
                    return Err(contract_error(
                        "An assignment slot is invalid or duplicates a stimulus.",
                    ));
                }
                per_pool.insert(slot.pool_id.as_str(), expected_pool_position);
                *computed_totals
                    .entry(slot.stimulus_id.as_str())
                    .or_insert(0) += 1;
                if let Some(counts) = computed_positions.get_mut(slot.stimulus_id.as_str()) {
                    counts[index] += 1;
                }
            }
            if self.pools.iter().any(|pool| {
                per_pool.get(pool.pool_id.as_str()).copied() != Some(pool.videos_per_participant)
            }) {
                return Err(contract_error(
                    "An assignment does not satisfy every pool count.",
                ));
            }
        }
        if self.exposure_counts.len() != self.stimuli.len() {
            return Err(contract_error(
                "Assignment exposure records are incomplete.",
            ));
        }
        let mut exposure_ids = HashSet::new();
        for exposure in &self.exposure_counts {
            if !exposure_ids.insert(exposure.stimulus_id.as_str())
                || computed_totals.get(exposure.stimulus_id.as_str()) != Some(&exposure.total)
                || computed_positions.get(exposure.stimulus_id.as_str())
                    != Some(&exposure.position_counts)
            {
                return Err(contract_error(
                    "An assignment exposure record does not match the schedule.",
                ));
            }
        }
        for pool in &self.pools {
            let totals = pool
                .stimulus_ids
                .iter()
                .map(|stimulus_id| {
                    computed_totals
                        .get(stimulus_id.as_str())
                        .copied()
                        .unwrap_or(0)
                })
                .collect::<Vec<_>>();
            let minimum = totals.iter().copied().min().unwrap_or(0);
            let maximum = totals.iter().copied().max().unwrap_or(0);
            if minimum == 0 || maximum.saturating_sub(minimum) > 1 {
                return Err(contract_error(
                    "The assignment plan violates balanced-v1 exposure coverage.",
                ));
            }
        }
        let observed = canonical_sha256(self, &["planHashSha256"])?;
        if observed != self.plan_hash_sha256 {
            return Err(contract_error(
                "The assignment plan hash does not match its canonical content.",
            ));
        }
        Ok(())
    }

    pub fn assignment_for(&self, participant_id: &str) -> Option<&ParticipantAssignmentV1> {
        self.assignments
            .iter()
            .find(|assignment| assignment.participant_id == participant_id)
    }

    pub fn stimulus_by_id(&self, stimulus_id: &str) -> Option<&StimulusV1> {
        self.stimuli
            .iter()
            .find(|stimulus| stimulus.stimulus_id == stimulus_id)
    }
}

fn expected_condition_rows(method: ConditionOrderV1, count: usize) -> Vec<Vec<usize>> {
    let base = (0..count)
        .map(|position| match method {
            ConditionOrderV1::Cyclic => position,
            ConditionOrderV1::Williams if position == 0 => 0,
            ConditionOrderV1::Williams if position % 2 == 1 => position.div_ceil(2),
            ConditionOrderV1::Williams => count - position / 2,
        })
        .collect::<Vec<_>>();
    let mut rows = (0..count)
        .map(|offset| {
            base.iter()
                .map(|index| (index + offset) % count)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if method == ConditionOrderV1::Williams && count % 2 == 1 {
        let reversed = rows
            .iter()
            .map(|row| row.iter().rev().copied().collect())
            .collect::<Vec<Vec<usize>>>();
        rows.extend(reversed);
    }
    rows
}

/// Independently resolves balanced-v1 in native code. Start accepts only a plan
/// byte-equivalent to this deterministic reconstruction; a renderer cannot
/// substitute a merely well-formed but differently allocated schedule.
pub fn resolve_assignment_plan_v1(
    settings: &ResearchSettingsV1,
) -> ResearchResult<ResolvedAssignmentPlanV1> {
    if settings.stimuli.items.is_empty() || settings.stimuli.pools.is_empty() {
        return Err(contract_error(
            "A resolved assignment requires at least one verified stimulus and pool.",
        ));
    }
    for pool in &settings.stimuli.pools {
        let capacity = u64::from(settings.experiment.participant_count)
            .saturating_mul(u64::from(pool.videos_per_participant));
        if pool.videos_per_participant as usize > pool.stimulus_ids.len()
            || capacity < pool.stimulus_ids.len() as u64
        {
            return Err(contract_error(
                "The cohort and per-participant pool count cannot cover unique stimuli.",
            ));
        }
    }
    let settings_sha256 = settings.canonical_sha256()?;
    let participant_width = settings
        .experiment
        .participant_count
        .to_string()
        .len()
        .max(3);
    let participant_ids = (1..=settings.experiment.participant_count)
        .map(|number| format!("P{number:0participant_width$}"))
        .collect::<Vec<_>>();
    let total_slots = settings
        .stimuli
        .pools
        .iter()
        .map(|pool| pool.videos_per_participant as usize)
        .sum::<usize>();
    let condition_rows = expected_condition_rows(
        settings.stimuli.condition_order,
        settings.stimuli.pools.len(),
    );
    let mut total_exposure = settings
        .stimuli
        .items
        .iter()
        .map(|item| (item.stimulus_id.clone(), 0u32))
        .collect::<HashMap<_, _>>();
    let mut position_exposure = settings
        .stimuli
        .items
        .iter()
        .map(|item| (item.stimulus_id.clone(), vec![0u32; total_slots]))
        .collect::<HashMap<_, _>>();
    let mut assignments = Vec::with_capacity(participant_ids.len());
    for (participant_index, participant_id) in participant_ids.iter().enumerate() {
        let pool_order = &condition_rows[participant_index % condition_rows.len()];
        let mut used = HashSet::new();
        let mut slots = Vec::with_capacity(total_slots);
        let mut per_pool_position = HashMap::<String, u32>::new();
        for pool_index in pool_order {
            let pool = &settings.stimuli.pools[*pool_index];
            for _ in 0..pool.videos_per_participant {
                let position = slots.len() + 1;
                let mut candidates = pool
                    .stimulus_ids
                    .iter()
                    .filter(|stimulus_id| !used.contains(stimulus_id.as_str()))
                    .map(|stimulus_id| {
                        let total = total_exposure[stimulus_id];
                        let at_position = position_exposure[stimulus_id][position - 1];
                        let mut digest = Sha256::new();
                        digest.update(b"affect-research:balanced-v1\0");
                        digest.update(settings.stimuli.seed.as_bytes());
                        digest.update([0]);
                        digest.update(participant_id.as_bytes());
                        digest.update([0]);
                        digest.update(pool.pool_id.as_bytes());
                        digest.update([0]);
                        digest.update(position.to_string().as_bytes());
                        digest.update([0]);
                        digest.update(stimulus_id.as_bytes());
                        (
                            total,
                            at_position,
                            <[u8; 32]>::from(digest.finalize()),
                            stimulus_id.clone(),
                        )
                    })
                    .collect::<Vec<_>>();
                candidates.sort();
                let Some((_, _, _, stimulus_id)) = candidates.into_iter().next() else {
                    return Err(contract_error(
                        "A pool has no remaining unique candidate for a participant.",
                    ));
                };
                used.insert(stimulus_id.clone());
                *total_exposure
                    .get_mut(&stimulus_id)
                    .expect("normalized stimulus exposure exists") += 1;
                position_exposure
                    .get_mut(&stimulus_id)
                    .expect("normalized position exposure exists")[position - 1] += 1;
                let pool_position = per_pool_position.entry(pool.pool_id.clone()).or_default();
                *pool_position += 1;
                slots.push(AssignmentSlotV1 {
                    position: position as u32,
                    pool_id: pool.pool_id.clone(),
                    pool_position: *pool_position,
                    stimulus_id,
                });
            }
        }
        assignments.push(ParticipantAssignmentV1 {
            participant_id: participant_id.clone(),
            condition_order: pool_order
                .iter()
                .map(|index| settings.stimuli.pools[*index].pool_id.clone())
                .collect(),
            slots,
        });
    }
    let exposure_counts = settings
        .stimuli
        .items
        .iter()
        .map(|item| StimulusExposureV1 {
            stimulus_id: item.stimulus_id.clone(),
            total: total_exposure[&item.stimulus_id],
            position_counts: position_exposure[&item.stimulus_id].clone(),
        })
        .collect();
    let mut plan = ResolvedAssignmentPlanV1 {
        schema: RESOLVED_ASSIGNMENT_PLAN_SCHEMA.to_owned(),
        version: 1,
        algorithm_version: AllocationAlgorithmV1::BalancedV1,
        seed: settings.stimuli.seed.clone(),
        condition_order: settings.stimuli.condition_order,
        settings_sha256,
        participant_ids,
        stimuli: settings.stimuli.items.clone(),
        pools: settings.stimuli.pools.clone(),
        assignments,
        exposure_counts,
        plan_hash_sha256: String::new(),
    };
    plan.plan_hash_sha256 = canonical_sha256(&plan, &["planHashSha256"])?;
    plan.validate(&plan.settings_sha256)?;
    Ok(plan)
}

impl SampleStimulusIdentityV1 {
    pub fn validate(&self) -> ResearchResult<()> {
        normalize_identifier(&self.stimulus_id, "stimulusIdentity.stimulusId")?;
        validate_finite_range(self.duration_ms, 1.0, 86_400_000.0, "stimulus duration")?;
        match self.kind {
            StimulusSourceKindV1::Youtube => {
                if self.sha256.is_some()
                    || self.byte_length.is_some()
                    || self.url.is_none()
                    || self.video_id.is_none()
                {
                    return Err(contract_error(
                        "A YouTube identity must be URL-bound and have no byte digest.",
                    ));
                }
            }
            StimulusSourceKindV1::WorkspaceFile | StimulusSourceKindV1::RepositoryAsset => {
                let Some(hash) = &self.sha256 else {
                    return Err(contract_error(
                        "A local stimulus identity requires a SHA-256 digest.",
                    ));
                };
                validate_sha256(hash, "stimulusIdentity.sha256")?;
                if self.byte_length.is_none() || self.url.is_some() || self.video_id.is_some() {
                    return Err(contract_error(
                        "A local stimulus identity must be byte-bound without a URL.",
                    ));
                }
            }
        }
        Ok(())
    }
}

impl ResearchRunManifestV2 {
    pub fn validate(&self) -> ResearchResult<()> {
        if self.schema != RESEARCH_RUN_MANIFEST_SCHEMA
            || self.version != 2
            || self.attempt_number == 0
            || self.age == 0
            || self.age > 120
            || self.session_stem.is_empty()
            || !self
                .session_stem
                .starts_with(&format!("{}_", self.participant_id))
        {
            return Err(contract_error("ResearchRunManifestV2 identity is invalid."));
        }
        validate_participant_id(&self.participant_id)?;
        validate_sha256(&self.settings_sha256, "manifest.settingsSha256")?;
        validate_sha256(
            &self.assignment_plan_sha256,
            "manifest.assignmentPlanSha256",
        )?;
        if UnicodeSegmentation::graphemes(self.participant_code.as_str(), true).count() != 2
            || self.participant_code.to_uppercase() != self.participant_code
            || self
                .participant_code
                .chars()
                .any(|character| character.is_control() || "/\\:*?\"<>|_".contains(character))
            || self.timing.sample_rate_hz == 0
            || self.timing.sample_rate_hz > 240
            || self.timing.gap_event_count > self.timing.event_count
            || (self.timing.gap_event_count == 0 && self.timing.missed_slot_count != 0)
            || self.timing.started_at.is_empty()
            || self.timing.finalized_at.is_empty()
        {
            return Err(contract_error("ResearchRunManifestV2 metadata is invalid."));
        }
        if self.stimuli.is_empty() {
            return Err(contract_error(
                "ResearchRunManifestV2 requires frozen stimulus identities.",
            ));
        }
        let mut stimulus_ids = HashSet::new();
        for identity in &self.stimuli {
            identity.validate()?;
            if !stimulus_ids.insert(identity.stimulus_id.as_str()) {
                return Err(contract_error(
                    "ResearchRunManifestV2 repeats a participant stimulus.",
                ));
            }
        }
        let mut output_kinds = HashSet::new();
        for output in &self.outputs {
            if !output_kinds.insert(output.kind)
                || output.file_name.is_empty()
                || output
                    .file_name
                    .chars()
                    .any(|character| matches!(character, '/' | '\\'))
                || output.byte_length == 0
            {
                return Err(contract_error(
                    "ResearchRunManifestV2 contains an invalid output receipt.",
                ));
            }
            validate_sha256(&output.sha256, "manifest.output.sha256")?;
            match output.kind {
                RunOutputKindV1::Csv | RunOutputKindV1::Tsv
                    if output.row_count == Some(self.timing.sample_count) => {}
                RunOutputKindV1::Settings | RunOutputKindV1::Events
                    if output.row_count.is_none() => {}
                _ => {
                    return Err(contract_error(
                        "Manifest output row counts do not match canonical samples.",
                    ))
                }
            }
        }
        if !output_kinds.contains(&RunOutputKindV1::Settings)
            || !output_kinds.contains(&RunOutputKindV1::Events)
            || (!output_kinds.contains(&RunOutputKindV1::Csv)
                && !output_kinds.contains(&RunOutputKindV1::Tsv))
        {
            return Err(contract_error(
                "Manifest outputs require settings, events, and at least one ratings table.",
            ));
        }
        if self.recovery.resumed != self.recovery.source_run_id.is_some() {
            return Err(contract_error(
                "Manifest recovery provenance is internally inconsistent.",
            ));
        }
        ensure_unique(
            self.recovery
                .restarted_stimulus_ids
                .iter()
                .map(String::as_str),
            "Manifest recovery repeats a restarted stimulus.",
        )?;
        if self.build.app_version.is_empty() || self.build.build_commit.is_empty() {
            return Err(contract_error("Manifest build provenance is incomplete."));
        }
        Ok(())
    }
}

pub fn canonical_json<T: Serialize>(value: &T, omit_root_keys: &[&str]) -> ResearchResult<Vec<u8>> {
    let mut value = serde_json::to_value(value)
        .map_err(|_| contract_error("The Research contract could not be canonicalized."))?;
    if let Value::Object(object) = &mut value {
        for key in omit_root_keys {
            object.remove(*key);
        }
    }
    let mut output = String::new();
    write_canonical_value(&value, &mut output)?;
    Ok(output.into_bytes())
}

pub fn canonical_sha256<T: Serialize>(
    value: &T,
    omit_root_keys: &[&str],
) -> ResearchResult<String> {
    let bytes = canonical_json(value, omit_root_keys)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn write_canonical_value(value: &Value, output: &mut String) -> ResearchResult<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                output.push_str(&value.to_string());
            } else if let Some(value) = number.as_u64() {
                output.push_str(&value.to_string());
            } else if let Some(value) = number.as_f64() {
                if !value.is_finite() {
                    return Err(contract_error("Canonical JSON rejects non-finite numbers."));
                }
                output.push_str(&normalize_zero(value).to_string());
            } else {
                return Err(contract_error(
                    "Canonical JSON encountered an invalid number.",
                ));
            }
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|_| contract_error("Canonical JSON could not encode a string."))?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_canonical_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let ordered: BTreeMap<&str, &Value> = values
                .iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect();
            for (index, (key, value)) in ordered.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|_| {
                    contract_error("Canonical JSON could not encode an object key.")
                })?);
                output.push(':');
                write_canonical_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn validate_transition(transition: &BetweenVideosV1) -> ResearchResult<()> {
    match transition {
        BetweenVideosV1::Fixed { duration_ms } if *duration_ms <= 3_600_000 => Ok(()),
        BetweenVideosV1::Jitter { durations_ms }
            if !durations_ms.is_empty()
                && durations_ms.len() <= 128
                && durations_ms.iter().all(|duration| *duration <= 3_600_000) =>
        {
            Ok(())
        }
        BetweenVideosV1::ContinueWhenReady => Ok(()),
        _ => Err(contract_error(
            "Between-video timing is outside the Research v1 bounds.",
        )),
    }
}

fn validate_local_source(
    mime_type: &mut String,
    sha256: &str,
    byte_length: u64,
    duration_ms: &mut f64,
) -> ResearchResult<()> {
    *mime_type = normalize_text(mime_type, 1, 100, "stimulus.mimeType")?;
    validate_sha256(sha256, "stimulus.sha256")?;
    if byte_length == 0 || byte_length > MAX_SAFE_INTEGER {
        return Err(contract_error(
            "Stimulus byteLength is outside the exact JSON integer range.",
        ));
    }
    *duration_ms = validated_number(*duration_ms, 1.0, 86_400_000.0, "stimulus.durationMs")?;
    Ok(())
}

fn validate_preset_payload(binding: &InputBindingV1) -> ResearchResult<()> {
    let expected = match binding.preset {
        InputPresetV1::Custom => {
            if binding.kind != InputKindV1::Digital {
                return Err(contract_error(
                    "Research v1 custom input supports digital actions only.",
                ));
            }
            return Ok(());
        }
        InputPresetV1::ArrowKeys => {
            preset_digital("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight")
        }
        InputPresetV1::Wasd => preset_digital("KeyW", "KeyS", "KeyA", "KeyD"),
        InputPresetV1::Ijkl => preset_digital("KeyI", "KeyK", "KeyJ", "KeyL"),
        InputPresetV1::Numpad => preset_digital("Numpad8", "Numpad2", "Numpad4", "Numpad6"),
        InputPresetV1::MouseButtonsWheel => InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.into(),
            version: 1,
            preset: InputPresetV1::MouseButtonsWheel,
            kind: InputKindV1::Digital,
            step_size: binding.step_size,
            directions: Some(DigitalDirectionsV1 {
                up: DigitalInputTokenV1::Wheel {
                    direction: DirectionV1::Up,
                },
                down: DigitalInputTokenV1::Wheel {
                    direction: DirectionV1::Down,
                },
                left: DigitalInputTokenV1::MouseButton { button: 2 },
                right: DigitalInputTokenV1::MouseButton { button: 0 },
            }),
            axes: None,
        },
        InputPresetV1::GamepadDpad => InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.into(),
            version: 1,
            preset: InputPresetV1::GamepadDpad,
            kind: InputKindV1::Digital,
            step_size: binding.step_size,
            directions: Some(DigitalDirectionsV1 {
                up: DigitalInputTokenV1::GamepadButton { button: 12 },
                down: DigitalInputTokenV1::GamepadButton { button: 13 },
                left: DigitalInputTokenV1::GamepadButton { button: 14 },
                right: DigitalInputTokenV1::GamepadButton { button: 15 },
            }),
            axes: None,
        },
        InputPresetV1::PointerGrid => preset_axes(
            InputPresetV1::PointerGrid,
            InputKindV1::Absolute,
            AxisInputTokenV1::PointerAxis {
                axis: AxisNameV1::X,
                invert: false,
            },
            AxisInputTokenV1::PointerAxis {
                axis: AxisNameV1::Y,
                invert: true,
            },
        ),
        InputPresetV1::GamepadLeftStick => preset_axes(
            InputPresetV1::GamepadLeftStick,
            InputKindV1::Analog,
            AxisInputTokenV1::GamepadAxis {
                index: 0,
                invert: false,
            },
            AxisInputTokenV1::GamepadAxis {
                index: 1,
                invert: true,
            },
        ),
        InputPresetV1::GamepadRightStick => preset_axes(
            InputPresetV1::GamepadRightStick,
            InputKindV1::Analog,
            AxisInputTokenV1::GamepadAxis {
                index: 2,
                invert: false,
            },
            AxisInputTokenV1::GamepadAxis {
                index: 3,
                invert: true,
            },
        ),
    };
    if binding.kind != expected.kind
        || binding.directions != expected.directions
        || binding.axes != expected.axes
    {
        return Err(contract_error(
            "Customized actions must use the custom input preset.",
        ));
    }
    Ok(())
}

fn preset_digital(up: &str, down: &str, left: &str, right: &str) -> InputBindingV1 {
    InputBindingV1 {
        schema: INPUT_BINDING_SCHEMA.into(),
        version: 1,
        preset: InputPresetV1::ArrowKeys,
        kind: InputKindV1::Digital,
        step_size: Some(0.1),
        directions: Some(DigitalDirectionsV1 {
            up: DigitalInputTokenV1::Keyboard { code: up.into() },
            down: DigitalInputTokenV1::Keyboard { code: down.into() },
            left: DigitalInputTokenV1::Keyboard { code: left.into() },
            right: DigitalInputTokenV1::Keyboard { code: right.into() },
        }),
        axes: None,
    }
}

fn preset_axes(
    preset: InputPresetV1,
    kind: InputKindV1,
    x: AxisInputTokenV1,
    y: AxisInputTokenV1,
) -> InputBindingV1 {
    InputBindingV1 {
        schema: INPUT_BINDING_SCHEMA.into(),
        version: 1,
        preset,
        kind,
        step_size: None,
        directions: None,
        axes: Some(InputAxesV1 { x, y }),
    }
}

fn normalize_identifier(value: &str, label: &str) -> ResearchResult<String> {
    let normalized = normalize_text(value, 1, 128, label)?.to_lowercase();
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return Err(contract_error(format!("{label} is empty.")));
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(contract_error(format!(
            "{label} must be a safe lowercase identifier."
        )));
    }
    if !characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
    }) {
        return Err(contract_error(format!(
            "{label} must be a safe lowercase identifier."
        )));
    }
    Ok(normalized)
}

fn normalize_text(
    value: &str,
    minimum: usize,
    maximum: usize,
    label: &str,
) -> ResearchResult<String> {
    let normalized: String = value.trim().nfc().collect();
    let count = normalized.chars().count();
    if count < minimum || count > maximum || normalized.contains('\0') {
        return Err(contract_error(format!(
            "{label} must contain {minimum}–{maximum} safe characters."
        )));
    }
    Ok(normalized)
}

pub fn normalize_relative_path(value: &str, required_root: Option<&str>) -> ResearchResult<String> {
    let mut normalized = normalize_text(value, 1, 512, "relativePath")?;
    if let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_owned();
    }
    if normalized.contains('\\')
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
    {
        return Err(contract_error(
            "Research paths must be relative and use forward slashes.",
        ));
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || matches!(*part, "." | "..")
            || part.chars().any(|character| {
                character.is_control()
                    || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
            })
    }) {
        return Err(contract_error(
            "A Research relative path contains an unsafe component.",
        ));
    }
    if required_root.is_some_and(|root| parts.first().copied() != Some(root)) {
        return Err(contract_error(
            "Workspace stimuli must be beneath stimuli/.",
        ));
    }
    Ok(parts.join("/"))
}

pub fn validate_participant_id(value: &str) -> ResearchResult<()> {
    if value.len() < 4
        || !value.starts_with('P')
        || !value[1..].bytes().all(|byte| byte.is_ascii_digit())
        || value[1..].len() < 3
    {
        return Err(contract_error(
            "Participant IDs must be P-prefixed and zero padded.",
        ));
    }
    Ok(())
}

pub fn validate_sha256(value: &str, label: &str) -> ResearchResult<()> {
    if value.len() != 64 || !is_lower_hex(value) {
        return Err(contract_error(format!(
            "{label} must be a lowercase SHA-256 digest."
        )));
    }
    Ok(())
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_youtube_host(host: Option<&str>) -> bool {
    host.is_some_and(|host| {
        let host = host.to_ascii_lowercase();
        host == "youtube.com"
            || host.ends_with(".youtube.com")
            || host == "youtu.be"
            || host.ends_with(".youtu.be")
    })
}

fn ensure_unique<'a>(
    values: impl Iterator<Item = &'a str>,
    message: &'static str,
) -> ResearchResult<()> {
    let mut observed = BTreeSet::new();
    for value in values {
        if !observed.insert(value) {
            return Err(contract_error(message));
        }
    }
    Ok(())
}

fn validated_number(value: f64, minimum: f64, maximum: f64, label: &str) -> ResearchResult<f64> {
    validate_finite_range(value, minimum, maximum, label)?;
    Ok(normalize_zero(value))
}

fn validate_finite_range(
    value: f64,
    minimum: f64,
    maximum: f64,
    label: &str,
) -> ResearchResult<()> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return Err(contract_error(format!(
            "{label} must be finite and within {minimum}–{maximum}."
        )));
    }
    Ok(())
}

fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn contract_error(message: impl Into<String>) -> CommandError {
    CommandError::invalid_contract(message)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn default_settings_json() -> Value {
        serde_json::json!({
            "schema": RESEARCH_SETTINGS_SCHEMA,
            "version": 1,
            "experiment": {
                "id": "video-affect-study",
                "title": "Video Affect Study",
                "participantCount": 24,
                "samplingFrequencyHz": 130,
                "betweenVideos": { "mode": "fixed", "durationMs": 5000 }
            },
            "stimuli": {
                "allocationAlgorithm": "balanced-v1",
                "conditionOrder": "williams",
                "seed": "000102030405060708090a0b0c0d0e0f",
                "items": [],
                "pools": []
            },
            "input": {
                "schema": INPUT_BINDING_SCHEMA,
                "version": 1,
                "preset": "arrowKeys",
                "kind": "digital",
                "stepSize": 0.1,
                "directions": {
                    "up": { "kind": "keyboard", "code": "ArrowUp" },
                    "down": { "kind": "keyboard", "code": "ArrowDown" },
                    "left": { "kind": "keyboard", "code": "ArrowLeft" },
                    "right": { "kind": "keyboard", "code": "ArrowRight" }
                },
                "axes": null
            },
            "visual": {
                "gridEnabled": true,
                "flubberEnabled": true,
                "sizePercent": 32,
                "transparency": 0.05,
                "hideFeedback": false,
                "overlayPosition": { "x": 0.72, "y": 0.5 },
                "lockPosition": false,
                "flubber": { "showOutline": true, "outlineThickness": 2, "showHalo": true },
                "grid": { "lineThickness": 1, "showOutline": true, "outlineThickness": 2, "cursorSize": 14 },
                "colors": {
                    "up": "#f2c94c", "down": "#2f80ed", "left": "#eb5757", "right": "#27ae60",
                    "idle": "#9ca3af", "outline": "#f8fafc", "halo": "#93c5fd", "cursor": "#ffffff"
                }
            },
            "advanced": {
                "lsl": {
                    "enabled": false,
                    "stateStream": "AffectResearch",
                    "streamType": "Affect",
                    "markerStream": "AffectResearchMarkers",
                    "sourceId": "affect-research"
                },
                "mappings": {
                    "oscillationFrequency": { "min": 0.5, "max": 2.5, "drivenBy": "y-axis", "reverse": false },
                    "edgeSmoothness": { "min": 0, "max": 1, "drivenBy": "x-axis", "reverse": false },
                    "projectionAmplitude": { "min": 0.2, "max": 0.4, "drivenBy": "y-axis", "reverse": false },
                    "pulseSynchrony": { "min": 0.2, "max": 1, "drivenBy": "x-axis", "reverse": false },
                    "waveSizeVariation": { "min": 0, "max": 0.8, "drivenBy": "x-axis", "reverse": true },
                    "saturation": { "min": 0, "max": 1, "drivenBy": "radius", "reverse": false }
                }
            },
            "output": { "csv": true, "tsv": false }
        })
    }

    pub(crate) fn default_settings() -> ResearchSettingsV1 {
        serde_json::from_value(default_settings_json()).unwrap()
    }

    #[test]
    fn settings_round_trip_and_validate() {
        let settings = default_settings().normalize_and_validate().unwrap();
        assert_eq!(settings.experiment.sampling_frequency_hz, 130);
        assert_eq!(settings.input.step_size, Some(0.1));
        assert_eq!(
            settings
                .advanced
                .mappings
                .wave_size_variation
                .evaluate(0.0, 0.0),
            0.4
        );
        let round_trip: ResearchSettingsV1 =
            serde_json::from_slice(&canonical_json(&settings, &[]).unwrap()).unwrap();
        assert_eq!(settings, round_trip);
    }

    #[test]
    fn unknown_fields_are_rejected_at_every_typed_boundary() {
        let mut value = default_settings_json();
        value["experiment"]["summaryRating"] = Value::Bool(true);
        assert!(serde_json::from_value::<ResearchSettingsV1>(value).is_err());

        let transition: Result<BetweenVideosV1, _> = serde_json::from_value(serde_json::json!({
            "mode": "fixed", "durationMs": 1000, "surprise": true
        }));
        assert!(transition.is_err());
    }

    #[test]
    fn invalid_bindings_and_cross_pool_membership_fail_closed() {
        let mut value = default_settings_json();
        value["input"]["directions"]["left"] = value["input"]["directions"]["right"].clone();
        let settings: ResearchSettingsV1 = serde_json::from_value(value).unwrap();
        assert!(settings.normalize_and_validate().is_err());
    }

    #[test]
    fn settings_preserve_over_requested_pool_counts_for_preflight_diagnostics() {
        let mut value = default_settings_json();
        value["stimuli"]["items"] = serde_json::json!([{
            "stimulusId":"video-a","title":"Video A","source":{
                "kind":"workspaceFile","relativePath":"stimuli/.workspace/wf-example",
                "mimeType":"video/mp4","sha256":"0".repeat(64),"byteLength":5,
                "durationMs":1000
            }
        }]);
        value["stimuli"]["pools"] = serde_json::json!([{
            "poolId":"pool-a","label":"Condition A","videosPerParticipant":2,
            "stimulusIds":["video-a"]
        }]);
        let settings: ResearchSettingsV1 = serde_json::from_value(value).unwrap();
        let normalized = settings.normalize_and_validate().unwrap();
        assert_eq!(normalized.stimuli.pools[0].videos_per_participant, 2);
    }

    #[test]
    fn settings_reject_duplicate_physical_stimuli_under_different_ids() {
        let mut local = default_settings_json();
        local["stimuli"]["items"] = serde_json::json!([
            {"stimulusId":"video-a","title":"Video A","source":{
                "kind":"workspaceFile","relativePath":"stimuli/a.mp4","mimeType":"video/mp4",
                "sha256":"1".repeat(64),"byteLength":5,"durationMs":1000
            }},
            {"stimulusId":"video-b","title":"Video B","source":{
                "kind":"repositoryAsset","relativePath":"assets/b.mp4","mimeType":"video/mp4",
                "sha256":"1".repeat(64),"byteLength":5,"durationMs":1000
            }}
        ]);
        local["stimuli"]["pools"] = serde_json::json!([{
            "poolId":"pool-a","label":"Condition A","videosPerParticipant":1,
            "stimulusIds":["video-a","video-b"]
        }]);
        let settings: ResearchSettingsV1 = serde_json::from_value(local).unwrap();
        assert!(settings.normalize_and_validate().is_err());

        let mut youtube = default_settings_json();
        youtube["stimuli"]["items"] = serde_json::json!([
            {"stimulusId":"video-a","title":"Video A","source":{
                "kind":"youtube","url":"https://www.youtube.com/watch?v=abc123def45",
                "videoId":"abc123def45","observedTitle":null,"observedDurationMs":null
            }},
            {"stimulusId":"video-b","title":"Video B","source":{
                "kind":"youtube","url":"https://youtu.be/abc123def45",
                "videoId":"abc123def45","observedTitle":null,"observedDurationMs":null
            }}
        ]);
        youtube["stimuli"]["pools"] = serde_json::json!([{
            "poolId":"pool-a","label":"Condition A","videosPerParticipant":1,
            "stimulusIds":["video-a","video-b"]
        }]);
        let settings: ResearchSettingsV1 = serde_json::from_value(youtube).unwrap();
        assert!(settings.normalize_and_validate().is_err());
    }

    #[test]
    fn manifest_participant_code_counts_unicode_graphemes() {
        let manifest = ResearchRunManifestV2 {
            schema: RESEARCH_RUN_MANIFEST_SCHEMA.to_owned(),
            version: 2,
            run_id: "run-1".to_owned(),
            experiment_id: "experiment".to_owned(),
            participant_id: "P001".to_owned(),
            participant_code: "A\u{301}B".to_owned(),
            age: 20,
            gender: GenderCodeV1::X,
            handedness: HandednessCodeV1::R,
            attempt_number: 1,
            session_stem: "P001_ÁB_A20_GX_HR_20260904T000000000Z_R01".to_owned(),
            completion_status: CompletionStatusV1::Completed,
            settings_sha256: "2".repeat(64),
            assignment_plan_sha256: "3".repeat(64),
            stimuli: vec![SampleStimulusIdentityV1 {
                kind: StimulusSourceKindV1::WorkspaceFile,
                stimulus_id: "video-a".to_owned(),
                sha256: Some("4".repeat(64)),
                byte_length: Some(5),
                duration_ms: 1_000.0,
                url: None,
                video_id: None,
            }],
            timing: RunTimingV1 {
                sample_rate_hz: 130,
                sample_count: 0,
                event_count: 0,
                gap_event_count: 0,
                missed_slot_count: 0,
                started_at: "2026-09-04T00:00:00Z".to_owned(),
                finalized_at: "2026-09-04T00:00:01Z".to_owned(),
            },
            outputs: vec![
                RunOutputV1 {
                    kind: RunOutputKindV1::Settings,
                    file_name: "settings.snapshot.json".to_owned(),
                    sha256: "5".repeat(64),
                    byte_length: 1,
                    row_count: None,
                },
                RunOutputV1 {
                    kind: RunOutputKindV1::Events,
                    file_name: "events.jsonl".to_owned(),
                    sha256: "6".repeat(64),
                    byte_length: 1,
                    row_count: None,
                },
                RunOutputV1 {
                    kind: RunOutputKindV1::Csv,
                    file_name: "ratings.csv".to_owned(),
                    sha256: "7".repeat(64),
                    byte_length: 1,
                    row_count: Some(0),
                },
            ],
            recovery: RecoverySummaryV1 {
                resumed: false,
                source_run_id: None,
                restarted_stimulus_ids: Vec::new(),
            },
            build: ResearchBuildV1 {
                platform: ResearchPlatformV1::TauriWindows,
                app_version: "0.4.0-alpha.1".to_owned(),
                build_commit: "8".repeat(40),
            },
        };
        assert!(manifest.validate().is_ok());
        let mut invalid = manifest;
        invalid.participant_code = "ABC".to_owned();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn canonical_json_sorts_keys_and_uses_javascript_style_integral_floats() {
        let value = serde_json::json!({ "z": 5.0, "a": { "y": 2, "x": 1 } });
        assert_eq!(
            String::from_utf8(canonical_json(&value, &[]).unwrap()).unwrap(),
            r#"{"a":{"x":1,"y":2},"z":5}"#
        );
    }

    #[test]
    fn mappings_follow_neutral_and_reversed_rules() {
        let settings = default_settings().normalize_and_validate().unwrap();
        assert_eq!(
            settings
                .advanced
                .mappings
                .oscillation_frequency
                .evaluate(0.0, 0.0),
            1.5
        );
        assert_eq!(
            settings
                .advanced
                .mappings
                .wave_size_variation
                .evaluate(-1.0, 0.0),
            0.8
        );
        assert_eq!(
            settings.advanced.mappings.saturation.evaluate(0.0, 0.0),
            0.0
        );
    }

    #[test]
    fn balanced_v1_matches_the_shared_javascript_golden_fixture() {
        let mut value = default_settings_json();
        value["experiment"]["participantCount"] = serde_json::json!(3);
        value["stimuli"]["seed"] = serde_json::json!("00112233445566778899aabbccddeeff");
        value["stimuli"]["items"] = Value::Array(
            (1..=4)
                .map(|number| {
                    let id = format!("a-{number:02}");
                    serde_json::json!({
                        "stimulusId":id,
                        "title":format!("Stimulus a-{number:02}"),
                        "source":{
                            "kind":"workspaceFile",
                            "relativePath":format!("stimuli/a-{number:02}.mp4"),
                            "mimeType":"video/mp4",
                            "sha256":format!("{:x}", Sha256::digest(id.as_bytes())),
                            "byteLength":1_000_000,
                            "durationMs":30_000
                        }
                    })
                })
                .collect(),
        );
        value["stimuli"]["pools"] = serde_json::json!([{
            "poolId":"pool-a","label":"Condition A","videosPerParticipant":2,
            "stimulusIds":["a-01","a-02","a-03","a-04"]
        }]);
        let settings = serde_json::from_value::<ResearchSettingsV1>(value)
            .unwrap()
            .normalize_and_validate()
            .unwrap();
        assert_eq!(
            settings.canonical_sha256().unwrap(),
            "4a73900c017ef2a049a9e18709c34b19d4b8a8d723ac4be4c5ef8bb299fb3f12"
        );
        let plan = resolve_assignment_plan_v1(&settings).unwrap();
        let selections = plan
            .assignments
            .iter()
            .map(|assignment| {
                assignment
                    .slots
                    .iter()
                    .map(|slot| slot.stimulus_id.as_str())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            selections,
            [
                vec!["a-02", "a-04"],
                vec!["a-01", "a-03"],
                vec!["a-04", "a-01"]
            ]
        );
        assert_eq!(
            plan.plan_hash_sha256,
            "c5672c056f8a4c11ab9ce9c795d9d642f3343e595b1fa501cffbed6145e18025"
        );
    }

    #[test]
    fn unsafe_relative_paths_and_unverified_local_media_are_rejected() {
        assert!(normalize_relative_path("stimuli/../private.mp4", Some("stimuli")).is_err());
        assert!(validate_sha256("ABC", "digest").is_err());
    }
}
