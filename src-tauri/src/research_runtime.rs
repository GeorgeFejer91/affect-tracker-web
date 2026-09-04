use crate::research_contracts::*;
use crate::research_error::{CommandError, ResearchResult};
use crate::research_input::{NativeDigitalInput, NativeInputMonitor};
use crate::research_lsl::{LslService, LslState};
use crate::research_native_media::{NativeMediaService, PlaybackMode, PlaybackQualification};
use crate::research_timing::DeadlineClock;
use crate::research_workspace::WorkspaceService;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

const BUILD_COMMIT: &str = env!("AFFECT_TRACKER_BUILD_COMMIT");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRunRequest {
    pub workspace_id: String,
    pub settings: ResearchSettingsV1,
    pub assignment_plan: ResolvedAssignmentPlanV1,
    pub participant: TransientParticipant,
    pub workspace_files: Vec<WorkspaceFileBinding>,
    pub rerun_confirmed: bool,
    #[serde(default)]
    pub playback_mode: PlaybackMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeRunRequest {
    pub workspace_id: String,
    pub recovery_id: String,
    pub settings: ResearchSettingsV1,
    pub assignment_plan: ResolvedAssignmentPlanV1,
    pub workspace_files: Vec<WorkspaceFileBinding>,
    #[serde(default)]
    pub playback_mode: PlaybackMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileBinding {
    pub stimulus_id: String,
    pub workspace_file_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransientParticipant {
    pub participant_id: String,
    pub participant_code: String,
    pub age: u8,
    pub gender: GenderCodeV1,
    pub handedness: HandednessCodeV1,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunReceipt {
    pub run_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub session_stem: String,
    pub settings_sha256: String,
    pub assignment_plan_sha256: String,
    pub output_receipt_id: String,
    pub resumed: bool,
    pub resume_at_stimulus_position: Option<u32>,
    pub playback_mode: PlaybackMode,
    pub playback_qualification: PlaybackQualification,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunPhase {
    Prepared,
    BetweenStimuli,
    Playing,
    Paused,
    Finalizing,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub active: bool,
    pub run_id: Option<String>,
    pub participant_id: Option<String>,
    pub attempt_number: Option<u32>,
    pub phase: RunPhase,
    pub sample_count: u64,
    pub event_count: u64,
    pub gap_event_count: u64,
    pub missed_slot_count: u64,
    pub current_valence: f64,
    pub current_arousal: f64,
    pub input_active: bool,
    pub active_stimulus_position: Option<u32>,
    pub last_safe_stimulus_position: u32,
    pub media_time_ms: Option<f64>,
    pub transition_duration_ms: Option<u32>,
    pub transition_remaining_ms: Option<f64>,
    pub transition_ready: bool,
    #[serde(skip_serializing)]
    transition_deadline: Option<Instant>,
    pub write_healthy: bool,
    pub lsl_enabled: bool,
    pub failure_code: Option<String>,
    pub playback_mode: Option<PlaybackMode>,
    pub playback_qualification: Option<PlaybackQualification>,
}

impl RunStatus {
    fn idle() -> Self {
        Self {
            active: false,
            run_id: None,
            participant_id: None,
            attempt_number: None,
            phase: RunPhase::Finished,
            sample_count: 0,
            event_count: 0,
            gap_event_count: 0,
            missed_slot_count: 0,
            current_valence: 0.0,
            current_arousal: 0.0,
            input_active: false,
            active_stimulus_position: None,
            last_safe_stimulus_position: 0,
            media_time_ms: None,
            transition_duration_ms: None,
            transition_remaining_ms: None,
            transition_ready: false,
            transition_deadline: None,
            write_healthy: true,
            lsl_enabled: false,
            failure_code: None,
            playback_mode: None,
            playback_qualification: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffectStateUpdate {
    pub valence: f64,
    pub arousal: f64,
    pub input_active: bool,
    pub input_kind: InputKindV1,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StimulusLifecycle {
    Started,
    Paused,
    Resumed,
    Completed,
    TransitionStarted,
    TransitionCompleted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StimulusStateUpdate {
    pub lifecycle: StimulusLifecycle,
    pub stimulus_id: String,
    pub stimulus_position: u32,
    pub media_time_ms: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FinishOutcome {
    Completed,
    StopEarly,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaPlaybackFailureReason {
    Aborted,
    Network,
    Decode,
    SourceNotSupported,
    Unknown,
}

impl MediaPlaybackFailureReason {
    fn detail_code(self) -> &'static str {
        match self {
            Self::Aborted => "media-aborted",
            Self::Network => "media-network",
            Self::Decode => "media-decode",
            Self::SourceNotSupported => "media-source-not-supported",
            Self::Unknown => "media-unknown",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaPlaybackFailureReport {
    pub reason: MediaPlaybackFailureReason,
    pub stimulus_id: String,
    pub stimulus_position: u32,
    pub media_time_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPlaybackFailureReceipt {
    pub run_id: String,
    pub recovery_id: String,
    pub failure_code: String,
    pub interrupted_stimulus_position: Option<u32>,
    pub last_safe_stimulus_position: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeReceipt {
    pub run_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub completion_status: CompletionStatusV1,
    pub output_receipt_id: String,
    pub files: Vec<FinalizedFileReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizedFileReceipt {
    pub file_name: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub recovery_id: String,
    pub run_id: String,
    pub experiment_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub last_safe_stimulus_position: u32,
    pub partial_sample_count: u64,
    pub settings_sha256: String,
    pub assignment_plan_sha256: String,
    pub playback_mode: PlaybackMode,
    pub playback_qualification: PlaybackQualification,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryListing {
    pub recoveries: Vec<RecoverySummary>,
    pub corrupt_recovery_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParticipantState {
    Available,
    Active,
    Partial,
    Complete,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantTileStatus {
    pub participant_id: String,
    pub state: ParticipantState,
    pub latest_attempt_number: Option<u32>,
    pub recoverable: bool,
}

pub struct ResearchRuntime {
    workspace: Arc<WorkspaceService>,
    native_media: Arc<NativeMediaService>,
    active: Mutex<Option<ActiveRun>>,
}

struct ActiveRun {
    sender: SyncSender<RunMessage>,
    status: Arc<Mutex<RunStatus>>,
    worker: Option<JoinHandle<()>>,
    input_monitor: NativeInputMonitor,
}

enum RunMessage {
    Affect(AffectStateUpdate),
    Stimulus(StimulusStateUpdate, mpsc::Sender<ResearchResult<()>>),
    DigitalInput(NativeDigitalInput),
    GamepadButton(u8, bool, mpsc::Sender<ResearchResult<()>>),
    Finish(FinishOutcome, mpsc::Sender<ResearchResult<FinalizeReceipt>>),
    MediaFailure(
        MediaPlaybackFailureReport,
        mpsc::Sender<ResearchResult<MediaPlaybackFailureReceipt>>,
    ),
    Interrupt(mpsc::Sender<ResearchResult<()>>),
}

impl ResearchRuntime {
    #[cfg(test)]
    pub fn new(workspace: Arc<WorkspaceService>) -> Self {
        Self::with_native_media(
            workspace,
            Arc::new(NativeMediaService::unavailable_for_tests()),
        )
    }

    pub fn with_native_media(
        workspace: Arc<WorkspaceService>,
        native_media: Arc<NativeMediaService>,
    ) -> Self {
        Self {
            workspace,
            native_media,
            active: Mutex::new(None),
        }
    }

    pub fn start_run(&self, request: StartRunRequest) -> ResearchResult<StartRunReceipt> {
        let mut active = self.lock_active();
        if active.is_some() {
            return Err(CommandError::run_active());
        }
        let playback_qualification = self
            .native_media
            .authorize_playback(request.playback_mode)?;
        let settings = request.settings.normalize_and_validate()?;
        let settings_sha256 = settings.canonical_sha256()?;
        request.assignment_plan.validate(&settings_sha256)?;
        validate_plan_matches_settings(&request.assignment_plan, &settings)?;
        validate_participant(&request.participant, &request.assignment_plan)?;
        verify_stimuli(
            &self.workspace,
            &request.workspace_id,
            &settings,
            &request.workspace_files,
        )?;

        let participant_code = validate_participant_code(&request.participant.participant_code)?;

        let assignment = request
            .assignment_plan
            .assignment_for(&request.participant.participant_id)
            .ok_or_else(|| CommandError::invalid_contract("The participant has no assignment."))?
            .clone();
        let (sender, receiver) = mpsc::sync_channel(512);
        let native_sender = sender.clone();
        let input_monitor = NativeInputMonitor::start(&settings.input, move |input| {
            let _ = native_sender.try_send(RunMessage::DigitalInput(input));
        })?;

        let prepared = self
            .workspace
            .with_workspace(&request.workspace_id, |root, _| {
                PreparedRun::create(
                    root,
                    settings,
                    request.assignment_plan,
                    assignment,
                    request.participant,
                    participant_code,
                    request.rerun_confirmed,
                    request.playback_mode,
                    playback_qualification,
                )
            })?;
        let receipt = prepared.receipt.clone();
        let status = Arc::new(Mutex::new(prepared.initial_status()));
        let worker_status = Arc::clone(&status);
        let worker = thread::Builder::new()
            .name("affect-research-writer".to_owned())
            .spawn(move || run_worker(prepared, receiver, worker_status))
            .map_err(|_| CommandError::io("The native run worker could not start."))?;
        *active = Some(ActiveRun {
            sender,
            status,
            worker: Some(worker),
            input_monitor,
        });
        Ok(receipt)
    }

    pub fn resume_run(&self, request: ResumeRunRequest) -> ResearchResult<StartRunReceipt> {
        let mut active = self.lock_active();
        if active.is_some() {
            return Err(CommandError::run_active());
        }
        let playback_qualification = self
            .native_media
            .authorize_playback(request.playback_mode)?;
        let settings = request.settings.normalize_and_validate()?;
        let settings_sha256 = settings.canonical_sha256()?;
        request.assignment_plan.validate(&settings_sha256)?;
        validate_plan_matches_settings(&request.assignment_plan, &settings)?;
        verify_stimuli(
            &self.workspace,
            &request.workspace_id,
            &settings,
            &request.workspace_files,
        )?;
        let prepared = self
            .workspace
            .with_workspace(&request.workspace_id, |root, _| {
                PreparedRun::resume(
                    root,
                    &request.recovery_id,
                    settings,
                    request.assignment_plan,
                    request.playback_mode,
                    playback_qualification,
                )
            })?;
        let (sender, receiver) = mpsc::sync_channel(512);
        let native_sender = sender.clone();
        let input_monitor = NativeInputMonitor::start(&prepared.settings.input, move |input| {
            let _ = native_sender.try_send(RunMessage::DigitalInput(input));
        })?;
        let receipt = prepared.receipt.clone();
        let status = Arc::new(Mutex::new(prepared.initial_status()));
        let worker_status = Arc::clone(&status);
        let worker = thread::Builder::new()
            .name("affect-research-writer".to_owned())
            .spawn(move || run_worker(prepared, receiver, worker_status))
            .map_err(|_| CommandError::io("The native recovery worker could not start."))?;
        *active = Some(ActiveRun {
            sender,
            status,
            worker: Some(worker),
            input_monitor,
        });
        Ok(receipt)
    }

    pub fn status(&self) -> RunStatus {
        let active = self.lock_active();
        let mut status = active
            .as_ref()
            .map(|run| lock(&run.status).clone())
            .unwrap_or_else(RunStatus::idle);
        if let Some(deadline) = status.transition_deadline {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or(Duration::ZERO);
            status.transition_remaining_ms = Some(duration_ms(remaining));
            status.transition_ready = remaining.is_zero();
        }
        status
    }

    pub fn update_affect(&self, update: AffectStateUpdate) -> ResearchResult<()> {
        validate_affect_update(&update)?;
        if update.input_kind == InputKindV1::Digital {
            return Err(CommandError::forbidden(
                "Digital ratings are owned by native edge capture, not WebView affect updates.",
            ));
        }
        self.send(RunMessage::Affect(update))
    }

    pub fn set_stimulus_state(&self, update: StimulusStateUpdate) -> ResearchResult<()> {
        if !update.media_time_ms.is_finite() || update.media_time_ms < 0.0 {
            return Err(CommandError::invalid_contract(
                "Stimulus media time must be a finite non-negative number.",
            ));
        }
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(RunMessage::Stimulus(update, reply_sender))?;
        reply_receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| CommandError::io("The stimulus lifecycle update timed out."))?
    }

    /// A bounded bridge for browser-polled gamepad D-pad events. Keyboard, mouse,
    /// and wheel edges are captured natively and never sent through the WebView.
    pub fn gamepad_button(&self, button: u8, pressed: bool) -> ResearchResult<()> {
        if button > 63 {
            return Err(CommandError::invalid_contract(
                "Gamepad button indices must be within 0–63.",
            ));
        }
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(RunMessage::GamepadButton(button, pressed, reply_sender))?;
        reply_receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| CommandError::io("The gamepad update timed out."))?
    }

    pub fn finish(&self, outcome: FinishOutcome) -> ResearchResult<FinalizeReceipt> {
        let mut active = self.lock_active();
        let Some(run) = active.as_ref() else {
            return Err(CommandError::no_active_run());
        };
        let (reply_sender, reply_receiver) = mpsc::channel();
        if run
            .sender
            .send(RunMessage::Finish(outcome, reply_sender))
            .is_err()
        {
            if let Some(mut failed) = active.take() {
                failed.input_monitor.stop();
                if let Some(worker) = failed.worker.take() {
                    let _ = worker.join();
                }
            }
            return Err(CommandError::io(
                "The native run worker is unavailable; recovery evidence was retained.",
            ));
        }
        let result = reply_receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| CommandError::io("The native run did not finalize in time."))?;
        if result.is_ok() {
            let mut run = active.take().expect("active run exists while finalizing");
            run.input_monitor.stop();
            if let Some(worker) = run.worker.take() {
                let _ = worker.join();
            }
        }
        result
    }

    pub fn report_media_failure(
        &self,
        report: MediaPlaybackFailureReport,
    ) -> ResearchResult<MediaPlaybackFailureReceipt> {
        if report.stimulus_id.is_empty()
            || report.stimulus_id.len() > 128
            || report.stimulus_position == 0
            || !report.media_time_ms.is_finite()
            || report.media_time_ms < 0.0
        {
            return Err(CommandError::invalid_contract(
                "The media failure report is outside the bounded playback contract.",
            ));
        }
        let mut active = self.lock_active();
        let Some(run) = active.as_ref() else {
            return Err(CommandError::no_active_run());
        };
        let (reply_sender, reply_receiver) = mpsc::channel();
        if run
            .sender
            .send(RunMessage::MediaFailure(report, reply_sender))
            .is_err()
        {
            if let Some(mut failed) = active.take() {
                failed.input_monitor.stop();
                if let Some(worker) = failed.worker.take() {
                    let _ = worker.join();
                }
            }
            return Err(CommandError::io(
                "The failed native media run retained its last recovery journal.",
            ));
        }
        let result = reply_receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| CommandError::io("The media failure could not be checkpointed in time."));
        let mut run = active
            .take()
            .expect("active run exists while interrupting media playback");
        run.input_monitor.stop();
        if let Some(worker) = run.worker.take() {
            let _ = worker.join();
        }
        result?
    }

    pub fn list_recoveries(&self, workspace_id: &str) -> ResearchResult<RecoveryListing> {
        self.workspace
            .with_workspace(workspace_id, |root, _| scan_recoveries(root))
    }

    pub fn participant_states(
        &self,
        workspace_id: &str,
        settings: ResearchSettingsV1,
    ) -> ResearchResult<Vec<ParticipantTileStatus>> {
        let settings = settings.normalize_and_validate()?;
        let active = self.status();
        self.workspace.with_workspace(workspace_id, |root, _| {
            reconstruct_participant_states(root, &settings, &active)
        })
    }

    pub fn shutdown(&self) {
        let _ = self.interrupt();
    }

    fn send(&self, message: RunMessage) -> ResearchResult<()> {
        let active = self.lock_active();
        let run = active.as_ref().ok_or_else(CommandError::no_active_run)?;
        run.sender
            .try_send(message)
            .map_err(|_| CommandError::io("The native run command queue is unavailable."))
    }

    fn interrupt(&self) -> ResearchResult<()> {
        let mut active = self.lock_active();
        let Some(mut run) = active.take() else {
            return Ok(());
        };
        run.input_monitor.stop();
        let (reply_sender, reply_receiver) = mpsc::channel();
        if run
            .sender
            .send(RunMessage::Interrupt(reply_sender))
            .is_err()
        {
            if let Some(worker) = run.worker.take() {
                let _ = worker.join();
            }
            return Err(CommandError::io(
                "The interrupted run retained its last recovery journal.",
            ));
        }
        let result = reply_receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| CommandError::io("The interrupted run could not flush in time."))?;
        if let Some(worker) = run.worker.take() {
            let _ = worker.join();
        }
        result
    }

    fn lock_active(&self) -> MutexGuard<'_, Option<ActiveRun>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct PreparedRun {
    receipt: StartRunReceipt,
    settings: ResearchSettingsV1,
    plan: ResolvedAssignmentPlanV1,
    assignment: ParticipantAssignmentV1,
    participant: CodedParticipant,
    started_at: String,
    run_epoch: Instant,
    files: RunFiles,
    lsl: Option<LslService>,
    sample_sequence: u64,
    event_sequence: u64,
    last_safe_position: u32,
    monotonic_offset_ns: u128,
    recovery: RecoverySummaryV1,
    resumed: bool,
}

#[derive(Clone)]
struct CodedParticipant {
    id: String,
    code: String,
    age: u8,
    gender: GenderCodeV1,
    handedness: HandednessCodeV1,
    attempt_number: u32,
}

impl PreparedRun {
    #[allow(clippy::too_many_arguments)]
    fn create(
        workspace_root: &Path,
        settings: ResearchSettingsV1,
        plan: ResolvedAssignmentPlanV1,
        assignment: ParticipantAssignmentV1,
        participant: TransientParticipant,
        participant_code: String,
        rerun_confirmed: bool,
        playback_mode: PlaybackMode,
        playback_qualification: PlaybackQualification,
    ) -> ResearchResult<Self> {
        let settings_sha256 = settings.canonical_sha256()?;
        let run_id = Uuid::new_v4().to_string();
        let started = OffsetDateTime::now_utc();
        let started_at = format_wall_time(started)?;
        let session_timestamp = started
            .format(format_description!(
                "[year][month][day]T[hour][minute][second][subsecond digits:3]Z"
            ))
            .map_err(|_| {
                CommandError::io("The native session timestamp could not be formatted.")
            })?;
        let participant_root = workspace_root
            .join("outputs")
            .join(&settings.experiment.id)
            .join(&participant.participant_id);
        fs::create_dir_all(&participant_root).map_err(CommandError::io)?;
        let attempt_lock = acquire_attempt_lock(&participant_root)?;
        let previous_attempts = count_previous_attempts(&participant_root)?;
        if previous_attempts > 0 && !rerun_confirmed {
            return Err(CommandError::forbidden(
                "This participant already has an attempt; an explicit rerun confirmation is required.",
            ));
        }
        let attempt_number = previous_attempts.saturating_add(1);
        let session_stem = format!(
            "{}_{}_A{}_G{:?}_H{:?}_{}_R{:02}",
            participant.participant_id,
            participant_code,
            participant.age,
            participant.gender,
            participant.handedness,
            session_timestamp,
            attempt_number
        );
        let session_dir = participant_root.join(&session_stem);
        fs::create_dir(&session_dir).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CommandError::forbidden("The new run destination already exists.")
            } else {
                CommandError::io(error)
            }
        })?;
        let output_receipt_id = Uuid::new_v4().to_string();
        let participant = CodedParticipant {
            id: participant.participant_id,
            code: participant_code,
            age: participant.age,
            gender: participant.gender,
            handedness: participant.handedness,
            attempt_number,
        };
        let files = RunFiles::create(
            workspace_root,
            &session_dir,
            &run_id,
            &settings,
            &plan,
            &participant,
            &session_stem,
            &started_at,
            playback_mode,
            playback_qualification,
            attempt_lock,
        )?;
        let lsl = if settings.advanced.lsl.enabled {
            Some(LslService::start(
                &settings.advanced.lsl,
                settings.experiment.sampling_frequency_hz,
                &run_id,
            )?)
        } else {
            None
        };
        Ok(Self {
            receipt: StartRunReceipt {
                run_id,
                participant_id: participant.id.clone(),
                attempt_number,
                session_stem,
                settings_sha256,
                assignment_plan_sha256: plan.plan_hash_sha256.clone(),
                output_receipt_id,
                resumed: false,
                resume_at_stimulus_position: Some(1),
                playback_mode,
                playback_qualification,
            },
            settings,
            plan,
            assignment,
            participant,
            started_at,
            run_epoch: Instant::now(),
            files,
            lsl,
            sample_sequence: 0,
            event_sequence: 0,
            last_safe_position: 0,
            monotonic_offset_ns: 0,
            recovery: RecoverySummaryV1 {
                resumed: false,
                source_run_id: None,
                restarted_stimulus_ids: Vec::new(),
            },
            resumed: false,
        })
    }

    fn resume(
        workspace_root: &Path,
        recovery_id: &str,
        settings: ResearchSettingsV1,
        plan: ResolvedAssignmentPlanV1,
        playback_mode: PlaybackMode,
        playback_qualification: PlaybackQualification,
    ) -> ResearchResult<Self> {
        let (recovery_path, journal) = load_recovery_journal(workspace_root, recovery_id)?;
        validate_recovery_journal(&journal, &settings, &plan)?;
        if journal.playback_mode != playback_mode
            || journal.playback_qualification != playback_qualification
        {
            return Err(CommandError::invalid_contract(
                "Recovery must use the frozen playback mode and qualification.",
            ));
        }
        let assignment = plan
            .assignment_for(&journal.participant_id)
            .ok_or_else(|| {
                CommandError::invalid_contract(
                    "The recovery participant is absent from the frozen assignment plan.",
                )
            })?
            .clone();
        if journal.last_safe_stimulus_position > assignment.slots.len() as u32 {
            return Err(CommandError::invalid_contract(
                "The recovery boundary exceeds the frozen participant assignment.",
            ));
        }
        let session_dir = recovery_session_dir(workspace_root, &journal)?;
        let participant_root = session_dir.parent().ok_or_else(|| {
            CommandError::forbidden("The recovery participant output is unavailable.")
        })?;
        let attempt_lock = acquire_attempt_lock(participant_root)?;
        verify_snapshot(
            &session_dir.join("settings.snapshot.json"),
            &canonical_json(&settings, &[])?,
            "settings",
        )?;
        verify_snapshot(
            &session_dir.join("assignment-plan.snapshot.json"),
            &canonical_json(&plan, &[])?,
            "assignment plan",
        )?;
        let (files, reconciled) = RunFiles::resume(
            &session_dir,
            recovery_path,
            journal.clone(),
            &settings,
            attempt_lock,
        )?;
        if reconciled.last_safe_position > assignment.slots.len() as u32 {
            return Err(CommandError::invalid_contract(
                "Recovered events exceed the frozen participant assignment.",
            ));
        }
        let restarted_stimulus_ids = reconciled
            .interrupted_stimulus_position
            .and_then(|position| {
                assignment
                    .slots
                    .get(position.saturating_sub(1) as usize)
                    .map(|slot| slot.stimulus_id.clone())
            })
            .into_iter()
            .collect();
        let participant = CodedParticipant {
            id: journal.participant_id.clone(),
            code: journal.participant_code.clone(),
            age: journal.age,
            gender: journal.gender,
            handedness: journal.handedness,
            attempt_number: journal.attempt_number,
        };
        let resume_at = (reconciled.last_safe_position < assignment.slots.len() as u32)
            .then_some(reconciled.last_safe_position + 1);
        let lsl = if settings.advanced.lsl.enabled {
            Some(LslService::start(
                &settings.advanced.lsl,
                settings.experiment.sampling_frequency_hz,
                &journal.run_id,
            )?)
        } else {
            None
        };
        Ok(Self {
            receipt: StartRunReceipt {
                run_id: journal.run_id.clone(),
                participant_id: journal.participant_id.clone(),
                attempt_number: journal.attempt_number,
                session_stem: journal.session_stem.clone(),
                settings_sha256: journal.settings_sha256.clone(),
                assignment_plan_sha256: journal.assignment_plan_sha256.clone(),
                output_receipt_id: Uuid::new_v4().to_string(),
                resumed: true,
                resume_at_stimulus_position: resume_at,
                playback_mode,
                playback_qualification,
            },
            settings,
            plan,
            assignment,
            participant,
            started_at: journal.started_at.clone(),
            run_epoch: Instant::now(),
            files,
            lsl,
            sample_sequence: reconciled.sample_count,
            event_sequence: reconciled.event_count,
            last_safe_position: reconciled.last_safe_position,
            monotonic_offset_ns: reconciled.last_monotonic_ns.saturating_add(1),
            recovery: RecoverySummaryV1 {
                resumed: true,
                source_run_id: Some(journal.run_id.clone()),
                restarted_stimulus_ids,
            },
            resumed: true,
        })
    }

    fn initial_status(&self) -> RunStatus {
        RunStatus {
            active: true,
            run_id: Some(self.receipt.run_id.clone()),
            participant_id: Some(self.participant.id.clone()),
            attempt_number: Some(self.participant.attempt_number),
            phase: RunPhase::Prepared,
            sample_count: self.sample_sequence,
            event_count: self.event_sequence,
            gap_event_count: self.files.journal.gap_event_count,
            missed_slot_count: self.files.journal.missed_slot_count,
            current_valence: 0.0,
            current_arousal: 0.0,
            input_active: false,
            active_stimulus_position: None,
            last_safe_stimulus_position: self.last_safe_position,
            media_time_ms: None,
            transition_duration_ms: None,
            transition_remaining_ms: None,
            transition_ready: false,
            transition_deadline: None,
            write_healthy: true,
            lsl_enabled: self.lsl.is_some(),
            failure_code: None,
            playback_mode: Some(self.receipt.playback_mode),
            playback_qualification: Some(self.receipt.playback_qualification),
        }
    }
}

fn run_worker(
    prepared: PreparedRun,
    receiver: Receiver<RunMessage>,
    shared_status: Arc<Mutex<RunStatus>>,
) {
    let mut worker = RunWorker::new(prepared, shared_status);
    if worker.start().is_err() {
        worker.fail("start-failed");
        return;
    }
    loop {
        let timeout = worker.timeout_until_sample();
        match receiver.recv_timeout(timeout) {
            Ok(RunMessage::Affect(update)) => worker.apply_affect(update),
            Ok(RunMessage::Stimulus(update, reply)) => {
                let _ = reply.send(worker.apply_stimulus(update));
            }
            Ok(RunMessage::DigitalInput(input)) => {
                if worker.apply_digital_input(input).is_err() {
                    worker.fail("input-edge-invalid");
                    return;
                }
            }
            Ok(RunMessage::GamepadButton(button, pressed, reply)) => {
                let _ = reply.send(worker.apply_gamepad_button(button, pressed));
            }
            Ok(RunMessage::Finish(outcome, reply)) => {
                let previous_phase = lock(&worker.status).phase;
                lock(&worker.status).phase = RunPhase::Finalizing;
                let result = worker.finalize(outcome);
                let should_exit = result.is_ok();
                if !should_exit {
                    lock(&worker.status).phase = previous_phase;
                }
                let _ = reply.send(result);
                if should_exit {
                    return;
                }
            }
            Ok(RunMessage::MediaFailure(report, reply)) => {
                let result = worker.interrupt_for_media_failure(report);
                let _ = reply.send(result);
                return;
            }
            Ok(RunMessage::Interrupt(reply)) => {
                let result = worker.interrupt();
                let _ = reply.send(result);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {
                if worker.sample_if_due().is_err() {
                    worker.fail("sample-write-failed");
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                // The recovery journal and partial tables intentionally remain authoritative.
                worker.fail("command-channel-disconnected");
                return;
            }
        }
    }
}

struct RunWorker {
    receipt: StartRunReceipt,
    settings: ResearchSettingsV1,
    plan: ResolvedAssignmentPlanV1,
    assignment: ParticipantAssignmentV1,
    participant: CodedParticipant,
    started_at: String,
    run_epoch: Instant,
    files: RunFiles,
    lsl: Option<LslService>,
    status: Arc<Mutex<RunStatus>>,
    state: AffectState,
    active_stimulus: Option<ActiveStimulus>,
    clock: Option<DeadlineClock>,
    sample_sequence: u64,
    event_sequence: u64,
    last_safe_position: u32,
    transition_active: bool,
    transition_deadline: Option<Instant>,
    ready_for_start: bool,
    native_input_active: bool,
    held_gamepad_buttons: HashSet<u8>,
    monotonic_offset_ns: u128,
    recovery: RecoverySummaryV1,
    resumed: bool,
}

#[derive(Clone, Copy)]
struct AffectState {
    current_x: f64,
    current_y: f64,
    target_x: f64,
    target_y: f64,
    anchor: Instant,
    continuous_input_active: bool,
    impulse_active_until: Instant,
}

#[derive(Clone)]
struct ActiveStimulus {
    identity: SampleStimulusIdentityV1,
    position: u32,
    media_anchor_ms: f64,
    media_anchor_at: Instant,
}

impl RunWorker {
    fn new(prepared: PreparedRun, status: Arc<Mutex<RunStatus>>) -> Self {
        let now = Instant::now();
        Self {
            receipt: prepared.receipt,
            settings: prepared.settings,
            plan: prepared.plan,
            assignment: prepared.assignment,
            participant: prepared.participant,
            started_at: prepared.started_at,
            run_epoch: prepared.run_epoch,
            files: prepared.files,
            lsl: prepared.lsl,
            status,
            state: AffectState {
                current_x: 0.0,
                current_y: 0.0,
                target_x: 0.0,
                target_y: 0.0,
                anchor: now,
                continuous_input_active: false,
                impulse_active_until: now,
            },
            active_stimulus: None,
            clock: None,
            sample_sequence: prepared.sample_sequence,
            event_sequence: prepared.event_sequence,
            last_safe_position: prepared.last_safe_position,
            transition_active: false,
            transition_deadline: None,
            ready_for_start: true,
            native_input_active: false,
            held_gamepad_buttons: HashSet::new(),
            monotonic_offset_ns: prepared.monotonic_offset_ns,
            recovery: prepared.recovery,
            resumed: prepared.resumed,
        }
    }

    fn start(&mut self) -> ResearchResult<()> {
        if self.resumed {
            self.write_event(
                ResearchEventTypeV1::WriteRecovered,
                None,
                None,
                Some("durable-prefix-reconciled".to_owned()),
            )?;
            self.write_event(
                ResearchEventTypeV1::RecoveryStarted,
                None,
                None,
                Some("safe-boundary-resume".to_owned()),
            )?;
            self.write_event(
                ResearchEventTypeV1::RecoveryCompleted,
                None,
                None,
                Some("partial-video-restarts-at-zero".to_owned()),
            )?;
        } else {
            let playback_detail = match self.receipt.playback_qualification {
                PlaybackQualification::QualifiedNative => "playback-native-libvlc-qualified",
                PlaybackQualification::Unqualified => "playback-webview-unqualified",
            };
            self.write_event(
                ResearchEventTypeV1::SessionPrepared,
                None,
                None,
                Some(playback_detail.to_owned()),
            )?;
            self.write_event(ResearchEventTypeV1::SessionStarted, None, None, None)?;
        }
        lock(&self.status).phase = RunPhase::BetweenStimuli;
        Ok(())
    }

    fn timeout_until_sample(&self) -> Duration {
        let Some(clock) = &self.clock else {
            return Duration::from_millis(250);
        };
        clock
            .next_deadline()
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO)
            .min(Duration::from_millis(250))
    }

    fn apply_affect(&mut self, update: AffectStateUpdate) {
        if update.input_kind != self.settings.input.kind {
            return;
        }
        if lock(&self.status).phase != RunPhase::Playing {
            return;
        }
        if matches!(
            update.input_kind,
            InputKindV1::Absolute | InputKindV1::Analog
        ) {
            let now = Instant::now();
            self.state.current_x = update.valence.clamp(-1.0, 1.0);
            self.state.current_y = update.arousal.clamp(-1.0, 1.0);
            self.state.target_x = self.state.current_x;
            self.state.target_y = self.state.current_y;
            self.state.anchor = now;
            self.state.continuous_input_active = update.input_active;
            let mut status = lock(&self.status);
            status.current_valence = self.state.current_x;
            status.current_arousal = self.state.current_y;
            status.input_active = update.input_active;
        }
    }

    fn apply_digital_input(&mut self, input: NativeDigitalInput) -> ResearchResult<()> {
        if self.settings.input.kind != InputKindV1::Digital {
            return Err(CommandError::forbidden(
                "Digital edges are not available for this input preset.",
            ));
        }
        if lock(&self.status).phase != RunPhase::Playing {
            return Ok(());
        }
        let now = Instant::now();
        if input.impulse {
            self.native_input_active = false;
            self.state.impulse_active_until = now + Duration::from_millis(100);
        } else {
            self.native_input_active = input.input_active;
        }
        if input.apply_step {
            self.apply_direction_step(input.direction, &input.detail, now)?;
        }
        self.publish_authoritative_state(now);
        Ok(())
    }

    fn apply_direction_step(
        &mut self,
        direction: DirectionV1,
        detail: &str,
        now: Instant,
    ) -> ResearchResult<()> {
        let step = self.settings.input.step_size.unwrap_or(0.1);
        match direction {
            DirectionV1::Up => self.state.target_y = (self.state.target_y + step).clamp(-1.0, 1.0),
            DirectionV1::Down => {
                self.state.target_y = (self.state.target_y - step).clamp(-1.0, 1.0)
            }
            DirectionV1::Left => {
                self.state.target_x = (self.state.target_x - step).clamp(-1.0, 1.0)
            }
            DirectionV1::Right => {
                self.state.target_x = (self.state.target_x + step).clamp(-1.0, 1.0)
            }
        }
        self.state.current_x = self.state.target_x;
        self.state.current_y = self.state.target_y;
        self.state.anchor = now;
        self.publish_authoritative_state(now);
        self.write_event(
            ResearchEventTypeV1::InputEdge,
            self.active_stimulus.clone(),
            None,
            Some(detail.to_owned()),
        )
    }

    fn apply_gamepad_button(&mut self, button: u8, pressed: bool) -> ResearchResult<()> {
        let directions = self
            .settings
            .input
            .directions
            .as_ref()
            .ok_or_else(|| CommandError::forbidden("This run does not use digital input."))?;
        let token = DigitalInputTokenV1::GamepadButton { button };
        let direction = directions.direction_for(&token).ok_or_else(|| {
            CommandError::forbidden("The gamepad button is not bound in this frozen run.")
        })?;
        if lock(&self.status).phase != RunPhase::Playing {
            return Ok(());
        }
        let changed = if pressed {
            self.held_gamepad_buttons.insert(button)
        } else {
            self.held_gamepad_buttons.remove(&button)
        };
        if !changed {
            // Duplicate browser polling notifications are the gamepad equivalent
            // of OS key repeat and never add another step.
            return Ok(());
        }
        let now = Instant::now();
        if pressed {
            self.apply_direction_step(direction, &token.detail_code(), now)?;
        }
        self.publish_authoritative_state(now);
        Ok(())
    }

    fn apply_stimulus(&mut self, update: StimulusStateUpdate) -> ResearchResult<()> {
        let current_phase = lock(&self.status).phase;
        let expected = self
            .assignment
            .slots
            .get(update.stimulus_position.saturating_sub(1) as usize)
            .filter(|slot| slot.position == update.stimulus_position)
            .ok_or_else(|| {
                CommandError::invalid_contract("The stimulus position is not assigned.")
            })?;
        if expected.stimulus_id != update.stimulus_id {
            return Err(CommandError::invalid_contract(
                "The stimulus does not match the frozen participant assignment.",
            ));
        }
        let stimulus = self
            .plan
            .stimulus_by_id(&update.stimulus_id)
            .ok_or_else(|| {
                CommandError::invalid_contract("The assigned stimulus is unavailable.")
            })?;
        let identity = stimulus.sample_identity();
        if update.media_time_ms > identity.duration_ms + 1_000.0 {
            return Err(CommandError::invalid_contract(
                "Stimulus media time exceeds its verified duration.",
            ));
        }
        let now = Instant::now();
        let active = ActiveStimulus {
            identity,
            position: update.stimulus_position,
            media_anchor_ms: update.media_time_ms,
            media_anchor_at: now,
        };
        let event_type = match update.lifecycle {
            StimulusLifecycle::Started => {
                if current_phase != RunPhase::BetweenStimuli
                    || !self.ready_for_start
                    || self.transition_active
                    || update.stimulus_position != self.last_safe_position + 1
                {
                    return Err(CommandError::invalid_contract(
                        "A stimulus can start only at the next safe assigned boundary.",
                    ));
                }
                if update.media_time_ms > 250.0 {
                    return Err(CommandError::invalid_contract(
                        "A stimulus must start at its safe beginning boundary.",
                    ));
                }
                self.active_stimulus = Some(active.clone());
                self.ready_for_start = false;
                self.clock = Some(DeadlineClock::new(
                    self.settings.experiment.sampling_frequency_hz,
                    now,
                )?);
                lock(&self.status).phase = RunPhase::Playing;
                ResearchEventTypeV1::StimulusStarted
            }
            StimulusLifecycle::Paused => {
                ensure_active_stimulus(
                    current_phase == RunPhase::Playing,
                    self.active_stimulus.as_ref(),
                    &active,
                )?;
                self.active_stimulus = Some(active.clone());
                self.clock = None;
                lock(&self.status).phase = RunPhase::Paused;
                ResearchEventTypeV1::StimulusPaused
            }
            StimulusLifecycle::Resumed => {
                ensure_active_stimulus(
                    current_phase == RunPhase::Paused,
                    self.active_stimulus.as_ref(),
                    &active,
                )?;
                self.active_stimulus = Some(active.clone());
                self.clock = Some(DeadlineClock::new(
                    self.settings.experiment.sampling_frequency_hz,
                    now,
                )?);
                lock(&self.status).phase = RunPhase::Playing;
                ResearchEventTypeV1::StimulusResumed
            }
            StimulusLifecycle::Completed => {
                ensure_active_stimulus(
                    matches!(current_phase, RunPhase::Playing | RunPhase::Paused),
                    self.active_stimulus.as_ref(),
                    &active,
                )?;
                self.active_stimulus = Some(active.clone());
                self.clock = None;
                self.last_safe_position = update.stimulus_position;
                self.ready_for_start =
                    self.last_safe_position == self.assignment.slots.len() as u32;
                self.reset_to_neutral(now);
                lock(&self.status).phase = RunPhase::BetweenStimuli;
                ResearchEventTypeV1::StimulusCompleted
            }
            StimulusLifecycle::TransitionStarted => {
                if current_phase != RunPhase::BetweenStimuli
                    || self.last_safe_position != update.stimulus_position
                    || self.transition_active
                    || self.ready_for_start
                {
                    return Err(CommandError::invalid_contract(
                        "A between-video transition must follow the completed stimulus boundary.",
                    ));
                }
                self.clock = None;
                self.transition_active = true;
                let transition_duration = transition_duration_ms(
                    &self.settings.experiment.between_videos,
                    &self.settings.stimuli.seed,
                    &self.participant.id,
                    self.last_safe_position,
                );
                self.transition_deadline = transition_duration
                    .map(|duration_ms| now + Duration::from_millis(u64::from(duration_ms)));
                {
                    let mut status = lock(&self.status);
                    status.transition_duration_ms = transition_duration;
                    status.transition_remaining_ms = transition_duration.map(f64::from);
                    status.transition_ready = transition_duration.is_none_or(|value| value == 0);
                    status.transition_deadline = self.transition_deadline;
                }
                self.reset_to_neutral(now);
                lock(&self.status).phase = RunPhase::BetweenStimuli;
                ResearchEventTypeV1::TransitionStarted
            }
            StimulusLifecycle::TransitionCompleted => {
                if current_phase != RunPhase::BetweenStimuli
                    || self.last_safe_position != update.stimulus_position
                    || !self.transition_active
                {
                    return Err(CommandError::invalid_contract(
                        "A transition can complete only after its matching start event.",
                    ));
                }
                if self
                    .transition_deadline
                    .is_some_and(|deadline| now < deadline)
                {
                    return Err(CommandError::forbidden(
                        "The native fixed/jitter transition deadline has not elapsed.",
                    ));
                }
                self.clock = None;
                self.transition_active = false;
                self.transition_deadline = None;
                {
                    let mut status = lock(&self.status);
                    status.transition_duration_ms = None;
                    status.transition_remaining_ms = None;
                    status.transition_ready = false;
                    status.transition_deadline = None;
                }
                self.ready_for_start = true;
                self.reset_to_neutral(now);
                lock(&self.status).phase = RunPhase::BetweenStimuli;
                ResearchEventTypeV1::TransitionCompleted
            }
        };
        self.write_event(event_type, Some(active), None, None)?;
        let mut status = lock(&self.status);
        status.last_safe_stimulus_position = self.last_safe_position;
        match update.lifecycle {
            StimulusLifecycle::Started | StimulusLifecycle::Paused | StimulusLifecycle::Resumed => {
                status.active_stimulus_position = Some(update.stimulus_position);
                status.media_time_ms = Some(update.media_time_ms);
            }
            StimulusLifecycle::Completed => {
                status.active_stimulus_position = None;
                status.media_time_ms = None;
                drop(status);
                self.active_stimulus = None;
            }
            StimulusLifecycle::TransitionStarted | StimulusLifecycle::TransitionCompleted => {
                status.active_stimulus_position = None;
                status.media_time_ms = None;
            }
        }
        Ok(())
    }

    fn reset_to_neutral(&mut self, now: Instant) {
        self.state.current_x = 0.0;
        self.state.current_y = 0.0;
        self.state.target_x = 0.0;
        self.state.target_y = 0.0;
        self.state.anchor = now;
        self.state.continuous_input_active = false;
        self.state.impulse_active_until = now;
        self.native_input_active = false;
        self.held_gamepad_buttons.clear();
        self.publish_authoritative_state(now);
    }

    fn current_input_active(&self, now: Instant) -> bool {
        match self.settings.input.kind {
            InputKindV1::Digital => {
                self.native_input_active
                    || !self.held_gamepad_buttons.is_empty()
                    || now < self.state.impulse_active_until
            }
            InputKindV1::Absolute | InputKindV1::Analog => self.state.continuous_input_active,
        }
    }

    fn publish_authoritative_state(&self, now: Instant) {
        let mut status = lock(&self.status);
        status.current_valence = self.state.current_x;
        status.current_arousal = self.state.current_y;
        status.input_active = self.current_input_active(now);
    }

    fn sample_if_due(&mut self) -> ResearchResult<()> {
        let now = Instant::now();
        let Some(clock) = &mut self.clock else {
            return Ok(());
        };
        let Some(due) = clock.poll(now) else {
            return Ok(());
        };
        let stimulus = self
            .active_stimulus
            .clone()
            .ok_or_else(CommandError::no_active_run)?;
        if due.missed_slots_before > 0 {
            self.write_event(
                ResearchEventTypeV1::TimingGap,
                Some(stimulus.clone()),
                Some(due.missed_slots_before),
                Some("native-deadline-missed".to_owned()),
            )?;
        }
        self.sample_sequence = self.sample_sequence.saturating_add(1);
        let x = self.state.current_x;
        let y = self.state.current_y;
        let radius = x.hypot(y).clamp(0.0, 1.0);
        let angle = if radius == 0.0 {
            0.0
        } else {
            y.atan2(x).to_degrees().rem_euclid(360.0)
        };
        let mappings = &self.settings.advanced.mappings;
        let input_active = self.current_input_active(now);
        let animation_active =
            self.settings.visual.flubber_enabled && lock(&self.status).phase == RunPhase::Playing;
        let lsl_state = LslState {
            current_valence: x,
            current_arousal: y,
            target_valence: self.state.target_x,
            target_arousal: self.state.target_y,
            radius,
            angle_degrees: angle,
            animation_active,
            input_active,
        };
        let lsl_time_seconds = self
            .lsl
            .as_ref()
            .map(|lsl| lsl.push_state(lsl_state))
            .transpose()?;
        let sample = ResearchSampleV1 {
            schema: RESEARCH_SAMPLE_SCHEMA.to_owned(),
            version: 1,
            sequence: self.sample_sequence,
            run_id: self.receipt.run_id.clone(),
            participant_id: self.participant.id.clone(),
            attempt_number: self.participant.attempt_number,
            settings_sha256: self.receipt.settings_sha256.clone(),
            assignment_plan_sha256: self.receipt.assignment_plan_sha256.clone(),
            stimulus_position: stimulus.position,
            stimulus_identity: stimulus.identity.clone(),
            wall_time_utc: wall_time_now()?,
            monotonic_time_ns: monotonic_ns(self.monotonic_offset_ns, self.run_epoch, now),
            lsl_time_seconds,
            sample_rate_hz: self.settings.experiment.sampling_frequency_hz,
            scheduled_elapsed_ms: duration_ms(due.scheduled_elapsed),
            observed_elapsed_ms: duration_ms(due.observed_elapsed),
            scheduler_lateness_ms: duration_ms(due.lateness),
            scheduler_jitter_ms: due.jitter_ms,
            state_anchor_age_ms: duration_ms(now.duration_since(self.state.anchor)),
            missed_slots_before: due.missed_slots_before,
            media_time_ms: (stimulus.media_anchor_ms
                + duration_ms(now.duration_since(stimulus.media_anchor_at)))
            .min(stimulus.identity.duration_ms),
            current_valence: x,
            current_arousal: y,
            target_valence: self.state.target_x,
            target_arousal: self.state.target_y,
            radius,
            angle_degrees: angle,
            oscillation_frequency: mappings.oscillation_frequency.evaluate(x, y),
            edge_smoothness: mappings.edge_smoothness.evaluate(x, y),
            projection_amplitude: mappings.projection_amplitude.evaluate(x, y),
            pulse_synchrony: mappings.pulse_synchrony.evaluate(x, y),
            wave_size_variation: mappings.wave_size_variation.evaluate(x, y),
            saturation: mappings.saturation.evaluate(x, y),
            animation_active,
            input_active,
            input_kind: self.settings.input.kind,
            feedback_visible: !self.settings.visual.hide_feedback
                && (self.settings.visual.grid_enabled || self.settings.visual.flubber_enabled),
        };
        self.files.write_sample(&sample)?;
        if self
            .sample_sequence
            .is_multiple_of(self.files.flush_every_samples)
        {
            self.checkpoint_journal(None, sample.monotonic_time_ns.clone())?;
        }
        let mut status = lock(&self.status);
        status.sample_count = self.sample_sequence;
        status.current_valence = x;
        status.current_arousal = y;
        status.input_active = input_active;
        status.active_stimulus_position = Some(stimulus.position);
        status.media_time_ms = Some(sample.media_time_ms);
        Ok(())
    }

    fn write_event(
        &mut self,
        event_type: ResearchEventTypeV1,
        stimulus: Option<ActiveStimulus>,
        missed_slot_count: Option<u64>,
        detail_code: Option<String>,
    ) -> ResearchResult<()> {
        self.event_sequence = self.event_sequence.saturating_add(1);
        let now = Instant::now();
        let (identity, position, media_time) = match stimulus {
            Some(stimulus) => {
                let media = (stimulus.media_anchor_ms
                    + duration_ms(now.duration_since(stimulus.media_anchor_at)))
                .min(stimulus.identity.duration_ms);
                (
                    Some(stimulus.identity),
                    Some(stimulus.position),
                    Some(media),
                )
            }
            None => (None, None, None),
        };
        let event = ResearchEventV1 {
            schema: RESEARCH_EVENT_SCHEMA.to_owned(),
            version: 1,
            sequence: self.event_sequence,
            run_id: self.receipt.run_id.clone(),
            participant_id: self.participant.id.clone(),
            attempt_number: self.participant.attempt_number,
            settings_sha256: self.receipt.settings_sha256.clone(),
            assignment_plan_sha256: self.receipt.assignment_plan_sha256.clone(),
            wall_time_utc: wall_time_now()?,
            monotonic_time_ns: monotonic_ns(self.monotonic_offset_ns, self.run_epoch, now),
            event_type,
            stimulus_identity: identity,
            stimulus_position: position,
            media_time_ms: media_time,
            missed_slot_count,
            detail_code,
        };
        self.files.write_event(&event)?;
        if let Some(lsl) = &self.lsl {
            let marker = event_marker(&event);
            lsl.push_marker(&marker)?;
        }
        {
            let mut status = lock(&self.status);
            status.event_count = self.event_sequence;
            if event_type == ResearchEventTypeV1::TimingGap {
                let missed = missed_slot_count.unwrap_or(0);
                status.gap_event_count = status.gap_event_count.saturating_add(1);
                status.missed_slot_count = status.missed_slot_count.saturating_add(missed);
            }
        }
        self.checkpoint_journal(None, event.monotonic_time_ns)
    }

    fn checkpoint_journal(
        &mut self,
        interrupted_stimulus_position: Option<u32>,
        last_monotonic_time_ns: String,
    ) -> ResearchResult<()> {
        let status = lock(&self.status).clone();
        self.files.update_journal(
            self.sample_sequence,
            self.event_sequence,
            self.last_safe_position,
            interrupted_stimulus_position,
            last_monotonic_time_ns,
            status.gap_event_count,
            status.missed_slot_count,
        )
    }

    fn finalize(&mut self, outcome: FinishOutcome) -> ResearchResult<FinalizeReceipt> {
        if matches!(outcome, FinishOutcome::Completed)
            && (self.last_safe_position != self.assignment.slots.len() as u32
                || matches!(
                    lock(&self.status).phase,
                    RunPhase::Playing | RunPhase::Paused
                ))
        {
            return Err(CommandError::invalid_contract(
                "A completed run must finish every assigned stimulus at a safe boundary.",
            ));
        }
        self.clock = None;
        let (event, completion_status) = match outcome {
            FinishOutcome::Completed => (
                ResearchEventTypeV1::SessionCompleted,
                CompletionStatusV1::Completed,
            ),
            FinishOutcome::StopEarly => (
                ResearchEventTypeV1::StoppedEarly,
                CompletionStatusV1::Partial,
            ),
        };
        self.write_event(event, self.active_stimulus.clone(), None, None)?;
        let status = lock(&self.status).clone();
        let receipt = self.files.finalize(
            &self.receipt,
            &self.settings,
            &self.assignment,
            &self.participant,
            &self.started_at,
            completion_status,
            &status,
            &self.recovery,
        )?;
        let mut shared = lock(&self.status);
        shared.active = false;
        shared.phase = RunPhase::Finished;
        Ok(receipt)
    }

    fn interrupt(&mut self) -> ResearchResult<()> {
        self.clock = None;
        self.write_event(
            ResearchEventTypeV1::WriteInterrupted,
            self.active_stimulus.clone(),
            None,
            Some("application-shutdown".to_owned()),
        )?;
        self.checkpoint_journal(
            self.active_stimulus
                .as_ref()
                .map(|stimulus| stimulus.position),
            monotonic_ns(self.monotonic_offset_ns, self.run_epoch, Instant::now()),
        )?;
        let mut status = lock(&self.status);
        status.active = false;
        status.phase = RunPhase::Finished;
        Ok(())
    }

    fn interrupt_for_media_failure(
        &mut self,
        report: MediaPlaybackFailureReport,
    ) -> ResearchResult<MediaPlaybackFailureReceipt> {
        self.clock = None;
        let report_matches_active = self.active_stimulus.as_ref().is_some_and(|stimulus| {
            stimulus.identity.stimulus_id == report.stimulus_id
                && stimulus.position == report.stimulus_position
                && report.media_time_ms <= stimulus.identity.duration_ms + 1_000.0
        });
        let failure_code = if report_matches_active {
            if let Some(stimulus) = &mut self.active_stimulus {
                stimulus.media_anchor_ms = report
                    .media_time_ms
                    .clamp(0.0, stimulus.identity.duration_ms);
                stimulus.media_anchor_at = Instant::now();
            }
            report.reason.detail_code()
        } else {
            "media-failure-contract-mismatch"
        };
        self.write_event(
            ResearchEventTypeV1::WriteInterrupted,
            self.active_stimulus.clone(),
            None,
            Some(failure_code.to_owned()),
        )?;
        let interrupted_stimulus_position = self
            .active_stimulus
            .as_ref()
            .map(|stimulus| stimulus.position);
        self.checkpoint_journal(
            interrupted_stimulus_position,
            monotonic_ns(self.monotonic_offset_ns, self.run_epoch, Instant::now()),
        )?;
        let mut status = lock(&self.status);
        status.active = false;
        status.phase = RunPhase::Failed;
        status.failure_code = Some(failure_code.to_owned());
        Ok(MediaPlaybackFailureReceipt {
            run_id: self.receipt.run_id.clone(),
            recovery_id: self.files.journal.recovery_id.clone(),
            failure_code: failure_code.to_owned(),
            interrupted_stimulus_position,
            last_safe_stimulus_position: self.last_safe_position,
        })
    }

    fn fail(&mut self, code: &str) {
        let mut status = lock(&self.status);
        status.phase = RunPhase::Failed;
        status.write_healthy = false;
        status.failure_code = Some(code.to_owned());
    }
}

fn validate_participant(
    participant: &TransientParticipant,
    plan: &ResolvedAssignmentPlanV1,
) -> ResearchResult<()> {
    validate_participant_id(&participant.participant_id)?;
    if participant.age == 0 || participant.age > 120 {
        return Err(CommandError::invalid_contract(
            "Participant age must be within 1–120.",
        ));
    }
    validate_participant_code(&participant.participant_code)?;
    if !plan.participant_ids.contains(&participant.participant_id) {
        return Err(CommandError::invalid_contract(
            "The participant is not present in the assignment plan.",
        ));
    }
    Ok(())
}

fn ensure_active_stimulus(
    phase_is_valid: bool,
    current: Option<&ActiveStimulus>,
    update: &ActiveStimulus,
) -> ResearchResult<()> {
    if !phase_is_valid
        || current.is_none_or(|current| {
            current.position != update.position || current.identity != update.identity
        })
    {
        return Err(CommandError::invalid_contract(
            "The stimulus lifecycle update is out of order or does not match the active item.",
        ));
    }
    Ok(())
}

fn validate_plan_matches_settings(
    plan: &ResolvedAssignmentPlanV1,
    settings: &ResearchSettingsV1,
) -> ResearchResult<()> {
    let participant_width = settings
        .experiment
        .participant_count
        .to_string()
        .len()
        .max(3);
    let expected_participants = (1..=settings.experiment.participant_count)
        .map(|number| format!("P{number:0participant_width$}"))
        .collect::<Vec<_>>();
    if plan.seed != settings.stimuli.seed
        || plan.condition_order != settings.stimuli.condition_order
        || plan.stimuli != settings.stimuli.items
        || plan.pools != settings.stimuli.pools
        || plan.participant_ids != expected_participants
    {
        return Err(CommandError::invalid_contract(
            "The resolved assignment plan does not exactly match the normalized settings.",
        ));
    }
    let independently_resolved = resolve_assignment_plan_v1(settings)?;
    if plan != &independently_resolved {
        return Err(CommandError::invalid_contract(
            "The supplied assignment differs from the native balanced-v1 reconstruction.",
        ));
    }
    for pool in &settings.stimuli.pools {
        let capacity = u64::from(settings.experiment.participant_count)
            .saturating_mul(u64::from(pool.videos_per_participant));
        if capacity < pool.stimulus_ids.len() as u64 {
            return Err(CommandError::invalid_contract(
                "The cohort does not provide enough slots to cover every selected stimulus.",
            ));
        }
    }
    Ok(())
}

fn validate_participant_code(code: &str) -> ResearchResult<String> {
    let normalized = code.trim().nfc().collect::<String>();
    let grapheme_count = UnicodeSegmentation::graphemes(normalized.as_str(), true).count();
    let reserved = normalized.chars().any(|character| {
        matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '_'
        ) || character.is_control()
    });
    if grapheme_count != 2
        || normalized.len() > 32
        || reserved
        || normalized.to_uppercase() != normalized
    {
        return Err(CommandError::invalid_contract(
            "Participant code must contain exactly two uppercase filename-safe graphemes.",
        ));
    }
    Ok(normalized)
}

fn validate_affect_update(update: &AffectStateUpdate) -> ResearchResult<()> {
    if update.input_kind == InputKindV1::Digital {
        return Err(CommandError::forbidden(
            "Digital ratings are owned by native edge capture, not WebView affect updates.",
        ));
    }
    if !update.valence.is_finite()
        || !update.arousal.is_finite()
        || !(-1.0..=1.0).contains(&update.valence)
        || !(-1.0..=1.0).contains(&update.arousal)
    {
        return Err(CommandError::invalid_contract(
            "Affect state coordinates must be finite values within -1..1.",
        ));
    }
    Ok(())
}

fn transition_duration_ms(
    policy: &BetweenVideosV1,
    seed: &str,
    participant_id: &str,
    safe_stimulus_position: u32,
) -> Option<u32> {
    match policy {
        BetweenVideosV1::Fixed { duration_ms } => Some(*duration_ms),
        BetweenVideosV1::ContinueWhenReady => None,
        BetweenVideosV1::Jitter { durations_ms } => {
            let mut digest = Sha256::new();
            digest.update(seed.as_bytes());
            digest.update([0]);
            digest.update(participant_id.as_bytes());
            digest.update([0]);
            digest.update(safe_stimulus_position.to_string().as_bytes());
            let bytes = digest.finalize();
            let prefix = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            durations_ms
                .get(prefix as usize % durations_ms.len())
                .copied()
        }
    }
}

fn verify_stimuli(
    workspace: &WorkspaceService,
    workspace_id: &str,
    settings: &ResearchSettingsV1,
    bindings: &[WorkspaceFileBinding],
) -> ResearchResult<()> {
    let workspace_count = settings
        .stimuli
        .items
        .iter()
        .filter(|stimulus| matches!(stimulus.source, StimulusSourceV1::WorkspaceFile { .. }))
        .count();
    let unique_binding_ids = bindings
        .iter()
        .map(|binding| binding.stimulus_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if bindings.len() != workspace_count || unique_binding_ids.len() != bindings.len() {
        return Err(CommandError::invalid_contract(
            "Every workspace stimulus requires exactly one opaque file binding.",
        ));
    }
    for stimulus in &settings.stimuli.items {
        match &stimulus.source {
            StimulusSourceV1::WorkspaceFile {
                sha256,
                byte_length,
                relative_path,
                mime_type,
                duration_ms,
                ..
            } => {
                let binding = bindings
                    .iter()
                    .find(|binding| binding.stimulus_id == stimulus.stimulus_id)
                    .ok_or_else(|| {
                        CommandError::invalid_contract(
                            "A workspace stimulus has no opaque file binding.",
                        )
                    })?;
                workspace.verify_workspace_file(
                    workspace_id,
                    &binding.workspace_file_id,
                    sha256,
                    *byte_length,
                    relative_path,
                    mime_type,
                    *duration_ms,
                )?;
            }
            StimulusSourceV1::RepositoryAsset { .. } => {
                return Err(CommandError::unsupported_source(
                    "Repository-asset verification is not available in this internal desktop build.",
                ));
            }
            StimulusSourceV1::Youtube { .. } => {
                return Err(CommandError::unsupported_source(
                    "Experimental YouTube playback has not passed the Tauri feasibility gate.",
                ));
            }
        }
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn monotonic_ns(offset_ns: u128, epoch: Instant, now: Instant) -> String {
    offset_ns
        .saturating_add(now.duration_since(epoch).as_nanos())
        .to_string()
}

fn wall_time_now() -> ResearchResult<String> {
    format_wall_time(OffsetDateTime::now_utc())
}

fn format_wall_time(time: OffsetDateTime) -> ResearchResult<String> {
    time.format(&Rfc3339)
        .map_err(|_| CommandError::io("The native wall-clock timestamp could not be formatted."))
}

fn count_previous_attempts(participant_root: &Path) -> ResearchResult<u32> {
    let mut count = 0u32;
    for entry in fs::read_dir(participant_root).map_err(CommandError::io)? {
        if entry
            .map_err(CommandError::io)?
            .file_type()
            .map_err(CommandError::io)?
            .is_dir()
        {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

fn acquire_attempt_lock(participant_root: &Path) -> ResearchResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(participant_root.join(".affect-research-attempt.lock"))
        .map_err(CommandError::io)?;
    file.try_lock_exclusive().map_err(|_| {
        CommandError::forbidden(
            "Another Affect Research process owns this participant's attempt lock.",
        )
    })?;
    Ok(file)
}

fn event_marker(event: &ResearchEventV1) -> String {
    let kind = format!("{:?}", event.event_type).to_ascii_lowercase();
    match &event.stimulus_identity {
        Some(identity) => format!(
            "{kind}:{}:{}",
            event.stimulus_position.unwrap_or(0),
            identity.stimulus_id
        ),
        None => kind,
    }
}

// Persistence is implemented below so that no filesystem handles cross the IPC boundary.

struct RunFiles {
    session_dir: PathBuf,
    recovery_path: PathBuf,
    settings_path: PathBuf,
    events_path: PathBuf,
    events: BufWriter<File>,
    csv_path: Option<PathBuf>,
    csv_partial_path: Option<PathBuf>,
    csv: Option<BufWriter<File>>,
    tsv_path: Option<PathBuf>,
    tsv_partial_path: Option<PathBuf>,
    tsv: Option<BufWriter<File>>,
    journal: RecoveryJournalV1,
    flush_every_samples: u64,
    _attempt_lock: File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryJournalV1 {
    schema: String,
    version: u32,
    recovery_id: String,
    run_id: String,
    experiment_id: String,
    participant_id: String,
    participant_code: String,
    age: u8,
    gender: GenderCodeV1,
    handedness: HandednessCodeV1,
    attempt_number: u32,
    session_stem: String,
    settings_sha256: String,
    assignment_plan_sha256: String,
    playback_mode: PlaybackMode,
    playback_qualification: PlaybackQualification,
    started_at: String,
    partial_sample_count: u64,
    partial_event_count: u64,
    last_safe_stimulus_position: u32,
    interrupted_stimulus_position: Option<u32>,
    last_monotonic_time_ns: String,
    gap_event_count: u64,
    missed_slot_count: u64,
}

struct ReconciledRun {
    sample_count: u64,
    event_count: u64,
    last_safe_position: u32,
    interrupted_stimulus_position: Option<u32>,
    last_monotonic_ns: u128,
}

struct ReconciledEvents {
    event_count: u64,
    last_safe_position: u32,
    interrupted_stimulus_position: Option<u32>,
    last_monotonic_ns: u128,
    gap_event_count: u64,
    missed_slot_count: u64,
}

struct ParsedTable {
    row_digests: Vec<[u8; 32]>,
    row_end_offsets: Vec<u64>,
    header_end_offset: u64,
    monotonic_values: Vec<u128>,
}

impl RunFiles {
    #[allow(clippy::too_many_arguments)]
    fn create(
        workspace_root: &Path,
        session_dir: &Path,
        run_id: &str,
        settings: &ResearchSettingsV1,
        plan: &ResolvedAssignmentPlanV1,
        participant: &CodedParticipant,
        session_stem: &str,
        started_at: &str,
        playback_mode: PlaybackMode,
        playback_qualification: PlaybackQualification,
        attempt_lock: File,
    ) -> ResearchResult<Self> {
        let settings_path = session_dir.join("settings.snapshot.json");
        write_new(&settings_path, &canonical_json(settings, &[])?)?;
        // The plan snapshot is intentionally local-only recovery evidence. Its digest is bound
        // into every row and manifest, while paths never cross the command boundary.
        write_new(
            &session_dir.join("assignment-plan.snapshot.json"),
            &canonical_json(plan, &[])?,
        )?;
        let events_path = session_dir.join("events.jsonl");
        let events = BufWriter::new(create_new_file(&events_path)?);
        let headers = sample_headers();
        let (csv_path, csv_partial_path, csv) = if settings.output.csv {
            let final_path = session_dir.join("ratings.csv");
            let partial_path = session_dir.join("ratings.csv.partial");
            let mut writer = BufWriter::new(create_new_file(&partial_path)?);
            write_delimited(&mut writer, &headers, b',')?;
            (Some(final_path), Some(partial_path), Some(writer))
        } else {
            (None, None, None)
        };
        let (tsv_path, tsv_partial_path, tsv) = if settings.output.tsv {
            let final_path = session_dir.join("ratings.tsv");
            let partial_path = session_dir.join("ratings.tsv.partial");
            let mut writer = BufWriter::new(create_new_file(&partial_path)?);
            write_delimited(&mut writer, &headers, b'\t')?;
            (Some(final_path), Some(partial_path), Some(writer))
        } else {
            (None, None, None)
        };
        let recovery_path = workspace_root
            .join("recovery")
            .join(format!("{run_id}.journal.json"));
        let journal = RecoveryJournalV1 {
            schema: "affect-research-recovery-journal".to_owned(),
            version: 1,
            recovery_id: Uuid::new_v4().to_string(),
            run_id: run_id.to_owned(),
            experiment_id: settings.experiment.id.clone(),
            participant_id: participant.id.clone(),
            participant_code: participant.code.clone(),
            age: participant.age,
            gender: participant.gender,
            handedness: participant.handedness,
            attempt_number: participant.attempt_number,
            session_stem: session_stem.to_owned(),
            settings_sha256: settings.canonical_sha256()?,
            assignment_plan_sha256: plan.plan_hash_sha256.clone(),
            playback_mode,
            playback_qualification,
            started_at: started_at.to_owned(),
            partial_sample_count: 0,
            partial_event_count: 0,
            last_safe_stimulus_position: 0,
            interrupted_stimulus_position: None,
            last_monotonic_time_ns: "0".to_owned(),
            gap_event_count: 0,
            missed_slot_count: 0,
        };
        write_journal_record(&recovery_path, &journal, true)?;
        Ok(Self {
            session_dir: session_dir.to_owned(),
            recovery_path,
            settings_path,
            events_path,
            events,
            csv_path,
            csv_partial_path,
            csv,
            tsv_path,
            tsv_partial_path,
            tsv,
            journal,
            flush_every_samples: (u64::from(settings.experiment.sampling_frequency_hz) / 4).max(1),
            _attempt_lock: attempt_lock,
        })
    }

    fn resume(
        session_dir: &Path,
        recovery_path: PathBuf,
        mut journal: RecoveryJournalV1,
        settings: &ResearchSettingsV1,
        attempt_lock: File,
    ) -> ResearchResult<(Self, ReconciledRun)> {
        if session_dir.join("manifest.json").exists() {
            return Err(CommandError::forbidden(
                "A finalized attempt cannot be resumed from a stale journal.",
            ));
        }
        let events_path = session_dir.join("events.jsonl");
        let recovered_events = reconcile_events(&events_path, &journal)?;
        let csv_partial_path = settings
            .output
            .csv
            .then(|| session_dir.join("ratings.csv.partial"));
        let tsv_partial_path = settings
            .output
            .tsv
            .then(|| session_dir.join("ratings.tsv.partial"));
        let csv_table = csv_partial_path
            .as_deref()
            .map(|path| parse_sample_table(path, b',', &journal))
            .transpose()?;
        let tsv_table = tsv_partial_path
            .as_deref()
            .map(|path| parse_sample_table(path, b'\t', &journal))
            .transpose()?;
        let mut common_count = match (&csv_table, &tsv_table) {
            (Some(csv), Some(tsv)) => csv.row_digests.len().min(tsv.row_digests.len()),
            (Some(csv), None) => csv.row_digests.len(),
            (None, Some(tsv)) => tsv.row_digests.len(),
            (None, None) => {
                return Err(CommandError::invalid_contract(
                    "Recovery requires at least one ratings table.",
                ))
            }
        };
        if let (Some(csv), Some(tsv)) = (&csv_table, &tsv_table) {
            common_count = (0..common_count)
                .take_while(|index| csv.row_digests[*index] == tsv.row_digests[*index])
                .count();
        }
        if let (Some(path), Some(table)) = (&csv_partial_path, &csv_table) {
            truncate_table_to_rows(path, table, common_count)?;
        }
        if let (Some(path), Some(table)) = (&tsv_partial_path, &tsv_table) {
            truncate_table_to_rows(path, table, common_count)?;
        }
        let sample_monotonic_ns = [csv_table.as_ref(), tsv_table.as_ref()]
            .into_iter()
            .flatten()
            .filter_map(|table| {
                common_count
                    .checked_sub(1)
                    .map(|index| table.monotonic_values[index])
            })
            .max()
            .unwrap_or(0);
        journal.partial_sample_count = common_count as u64;
        journal.partial_event_count = recovered_events.event_count;
        journal.last_safe_stimulus_position = recovered_events.last_safe_position;
        journal.interrupted_stimulus_position = recovered_events.interrupted_stimulus_position;
        journal.last_monotonic_time_ns = sample_monotonic_ns
            .max(recovered_events.last_monotonic_ns)
            .to_string();
        journal.gap_event_count = recovered_events.gap_event_count;
        journal.missed_slot_count = recovered_events.missed_slot_count;
        write_journal_record(&recovery_path, &journal, false)?;

        let events = BufWriter::new(open_append(&events_path)?);
        let csv = csv_partial_path
            .as_deref()
            .map(open_append)
            .transpose()?
            .map(BufWriter::new);
        let tsv = tsv_partial_path
            .as_deref()
            .map(open_append)
            .transpose()?
            .map(BufWriter::new);
        let files = Self {
            session_dir: session_dir.to_owned(),
            recovery_path,
            settings_path: session_dir.join("settings.snapshot.json"),
            events_path,
            events,
            csv_path: settings.output.csv.then(|| session_dir.join("ratings.csv")),
            csv_partial_path,
            csv,
            tsv_path: settings.output.tsv.then(|| session_dir.join("ratings.tsv")),
            tsv_partial_path,
            tsv,
            journal,
            flush_every_samples: (u64::from(settings.experiment.sampling_frequency_hz) / 4).max(1),
            _attempt_lock: attempt_lock,
        };
        Ok((
            files,
            ReconciledRun {
                sample_count: common_count as u64,
                event_count: recovered_events.event_count,
                last_safe_position: recovered_events.last_safe_position,
                interrupted_stimulus_position: recovered_events.interrupted_stimulus_position,
                last_monotonic_ns: sample_monotonic_ns.max(recovered_events.last_monotonic_ns),
            },
        ))
    }

    fn write_event(&mut self, event: &ResearchEventV1) -> ResearchResult<()> {
        let bytes = canonical_json(event, &[])?;
        self.events.write_all(&bytes).map_err(CommandError::io)?;
        self.events.write_all(b"\n").map_err(CommandError::io)?;
        self.events.flush().map_err(CommandError::io)
    }

    fn write_sample(&mut self, sample: &ResearchSampleV1) -> ResearchResult<()> {
        sample.stimulus_identity.validate()?;
        let values = sample_values(sample)?;
        if let Some(csv) = &mut self.csv {
            write_delimited(csv, &values, b',')?;
        }
        if let Some(tsv) = &mut self.tsv {
            write_delimited(tsv, &values, b'\t')?;
        }
        if sample.sequence.is_multiple_of(self.flush_every_samples) {
            self.flush_tables()?;
        }
        Ok(())
    }

    fn flush_tables(&mut self) -> ResearchResult<()> {
        if let Some(csv) = &mut self.csv {
            csv.flush().map_err(CommandError::io)?;
        }
        if let Some(tsv) = &mut self.tsv {
            tsv.flush().map_err(CommandError::io)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn update_journal(
        &mut self,
        sample_count: u64,
        event_count: u64,
        last_safe_position: u32,
        interrupted_stimulus_position: Option<u32>,
        last_monotonic_time_ns: String,
        gap_event_count: u64,
        missed_slot_count: u64,
    ) -> ResearchResult<()> {
        self.sync_outputs()?;
        self.journal.partial_sample_count = sample_count;
        self.journal.partial_event_count = event_count;
        self.journal.last_safe_stimulus_position = last_safe_position;
        self.journal.interrupted_stimulus_position = interrupted_stimulus_position;
        self.journal.last_monotonic_time_ns = last_monotonic_time_ns;
        self.journal.gap_event_count = gap_event_count;
        self.journal.missed_slot_count = missed_slot_count;
        write_journal_record(&self.recovery_path, &self.journal, false)
    }

    fn sync_outputs(&mut self) -> ResearchResult<()> {
        self.flush_tables()?;
        self.events.flush().map_err(CommandError::io)?;
        self.events
            .get_ref()
            .sync_data()
            .map_err(CommandError::io)?;
        if let Some(csv) = &self.csv {
            csv.get_ref().sync_data().map_err(CommandError::io)?;
        }
        if let Some(tsv) = &self.tsv {
            tsv.get_ref().sync_data().map_err(CommandError::io)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize(
        &mut self,
        receipt: &StartRunReceipt,
        settings: &ResearchSettingsV1,
        assignment: &ParticipantAssignmentV1,
        participant: &CodedParticipant,
        started_at: &str,
        completion_status: CompletionStatusV1,
        status: &RunStatus,
        recovery: &RecoverySummaryV1,
    ) -> ResearchResult<FinalizeReceipt> {
        self.flush_tables()?;
        self.events.flush().map_err(CommandError::io)?;
        self.events.get_ref().sync_all().map_err(CommandError::io)?;
        if let Some(csv) = &self.csv {
            csv.get_ref().sync_all().map_err(CommandError::io)?;
        }
        if let Some(tsv) = &self.tsv {
            tsv.get_ref().sync_all().map_err(CommandError::io)?;
        }
        if let (Some(partial), Some(final_path)) = (&self.csv_partial_path, &self.csv_path) {
            fs::rename(partial, final_path).map_err(CommandError::io)?;
        }
        if let (Some(partial), Some(final_path)) = (&self.tsv_partial_path, &self.tsv_path) {
            fs::rename(partial, final_path).map_err(CommandError::io)?;
        }

        let mut outputs = vec![
            output_record(RunOutputKindV1::Settings, &self.settings_path, None)?,
            output_record(RunOutputKindV1::Events, &self.events_path, None)?,
        ];
        if let Some(path) = &self.csv_path {
            outputs.push(output_record(
                RunOutputKindV1::Csv,
                path,
                Some(status.sample_count),
            )?);
        }
        if let Some(path) = &self.tsv_path {
            outputs.push(output_record(
                RunOutputKindV1::Tsv,
                path,
                Some(status.sample_count),
            )?);
        }
        let stimuli = assignment
            .slots
            .iter()
            .filter_map(|slot| {
                settings
                    .stimuli
                    .items
                    .iter()
                    .find(|item| item.stimulus_id == slot.stimulus_id)
                    .map(StimulusV1::sample_identity)
            })
            .collect();
        let manifest = ResearchRunManifestV2 {
            schema: RESEARCH_RUN_MANIFEST_SCHEMA.to_owned(),
            version: 2,
            run_id: receipt.run_id.clone(),
            experiment_id: settings.experiment.id.clone(),
            participant_id: participant.id.clone(),
            participant_code: participant.code.clone(),
            age: participant.age,
            gender: participant.gender,
            handedness: participant.handedness,
            attempt_number: participant.attempt_number,
            session_stem: receipt.session_stem.clone(),
            completion_status,
            settings_sha256: receipt.settings_sha256.clone(),
            assignment_plan_sha256: receipt.assignment_plan_sha256.clone(),
            stimuli,
            timing: RunTimingV1 {
                sample_rate_hz: settings.experiment.sampling_frequency_hz,
                sample_count: status.sample_count,
                event_count: status.event_count,
                gap_event_count: status.gap_event_count,
                missed_slot_count: status.missed_slot_count,
                started_at: started_at.to_owned(),
                finalized_at: wall_time_now()?,
            },
            outputs,
            recovery: recovery.clone(),
            build: ResearchBuildV1 {
                platform: ResearchPlatformV1::TauriWindows,
                app_version: APP_VERSION.to_owned(),
                build_commit: BUILD_COMMIT.to_owned(),
            },
        };
        manifest.validate()?;
        let manifest_path = self.session_dir.join("manifest.json");
        write_new(&manifest_path, &canonical_json(&manifest, &[])?)?;
        let manifest_file = file_receipt(&manifest_path)?;
        let mut files = manifest
            .outputs
            .iter()
            .map(|output| FinalizedFileReceipt {
                file_name: output.file_name.clone(),
                sha256: output.sha256.clone(),
                byte_length: output.byte_length,
            })
            .collect::<Vec<_>>();
        files.push(manifest_file);
        fs::remove_file(&self.recovery_path).map_err(CommandError::io)?;
        Ok(FinalizeReceipt {
            run_id: receipt.run_id.clone(),
            participant_id: participant.id.clone(),
            attempt_number: participant.attempt_number,
            completion_status,
            output_receipt_id: receipt.output_receipt_id.clone(),
            files,
        })
    }
}

fn sample_headers() -> Vec<String> {
    [
        "schema",
        "version",
        "sequence",
        "runId",
        "participantId",
        "attemptNumber",
        "settingsSha256",
        "assignmentPlanSha256",
        "stimulusPosition",
        "stimulusIdentity",
        "wallTimeUtc",
        "monotonicTimeNs",
        "lslTimeSeconds",
        "sampleRateHz",
        "scheduledElapsedMs",
        "observedElapsedMs",
        "schedulerLatenessMs",
        "schedulerJitterMs",
        "stateAnchorAgeMs",
        "missedSlotsBefore",
        "mediaTimeMs",
        "currentValence",
        "currentArousal",
        "targetValence",
        "targetArousal",
        "radius",
        "angleDegrees",
        "oscillationFrequency",
        "edgeSmoothness",
        "projectionAmplitude",
        "pulseSynchrony",
        "waveSizeVariation",
        "saturation",
        "animationActive",
        "inputActive",
        "inputKind",
        "feedbackVisible",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn sample_values(sample: &ResearchSampleV1) -> ResearchResult<Vec<String>> {
    let input_kind = serde_json::to_value(sample.input_kind)
        .map_err(|_| CommandError::io("The input kind could not be encoded."))?
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(vec![
        sample.schema.clone(),
        sample.version.to_string(),
        sample.sequence.to_string(),
        sample.run_id.clone(),
        sample.participant_id.clone(),
        sample.attempt_number.to_string(),
        sample.settings_sha256.clone(),
        sample.assignment_plan_sha256.clone(),
        sample.stimulus_position.to_string(),
        String::from_utf8(canonical_json(&sample.stimulus_identity, &[])?).map_err(|_| {
            CommandError::io("The stimulus identity could not be encoded as UTF-8.")
        })?,
        sample.wall_time_utc.clone(),
        sample.monotonic_time_ns.clone(),
        sample
            .lsl_time_seconds
            .map(canonical_number)
            .unwrap_or_default(),
        sample.sample_rate_hz.to_string(),
        canonical_number(sample.scheduled_elapsed_ms),
        canonical_number(sample.observed_elapsed_ms),
        canonical_number(sample.scheduler_lateness_ms),
        canonical_number(sample.scheduler_jitter_ms),
        canonical_number(sample.state_anchor_age_ms),
        sample.missed_slots_before.to_string(),
        canonical_number(sample.media_time_ms),
        canonical_number(sample.current_valence),
        canonical_number(sample.current_arousal),
        canonical_number(sample.target_valence),
        canonical_number(sample.target_arousal),
        canonical_number(sample.radius),
        canonical_number(sample.angle_degrees),
        canonical_number(sample.oscillation_frequency),
        canonical_number(sample.edge_smoothness),
        canonical_number(sample.projection_amplitude),
        canonical_number(sample.pulse_synchrony),
        canonical_number(sample.wave_size_variation),
        canonical_number(sample.saturation),
        sample.animation_active.to_string(),
        sample.input_active.to_string(),
        input_kind,
        sample.feedback_visible.to_string(),
    ])
}

fn canonical_number(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        value.to_string()
    }
}

fn write_delimited(
    writer: &mut BufWriter<File>,
    values: &[String],
    delimiter: u8,
) -> ResearchResult<()> {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            writer.write_all(&[delimiter]).map_err(CommandError::io)?;
        }
        let needs_quotes = value
            .bytes()
            .any(|byte| byte == delimiter || matches!(byte, b'"' | b'\r' | b'\n'));
        if needs_quotes {
            writer.write_all(b"\"").map_err(CommandError::io)?;
            writer
                .write_all(value.replace('"', "\"\"").as_bytes())
                .map_err(CommandError::io)?;
            writer.write_all(b"\"").map_err(CommandError::io)?;
        } else {
            writer
                .write_all(value.as_bytes())
                .map_err(CommandError::io)?;
        }
    }
    writer.write_all(b"\n").map_err(CommandError::io)
}

fn create_new_file(path: &Path) -> ResearchResult<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(CommandError::io)
}

fn write_new(path: &Path, bytes: &[u8]) -> ResearchResult<()> {
    let mut file = create_new_file(path)?;
    file.write_all(bytes).map_err(CommandError::io)?;
    file.sync_all().map_err(CommandError::io)
}

fn write_journal_record(
    path: &Path,
    journal: &RecoveryJournalV1,
    create_new: bool,
) -> ResearchResult<()> {
    if !create_new {
        truncate_incomplete_journal_tail(path)?;
    }
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.append(true);
    }
    let mut file = options.open(path).map_err(CommandError::io)?;
    let mut record = canonical_json(journal, &[])?;
    record.push(b'\n');
    file.write_all(&record).map_err(CommandError::io)?;
    file.sync_data().map_err(CommandError::io)
}

fn truncate_incomplete_journal_tail(path: &Path) -> ResearchResult<()> {
    let bytes = fs::read(path).map_err(CommandError::io)?;
    if bytes.is_empty() || bytes.ends_with(b"\n") {
        return Ok(());
    }
    let complete_length = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|position| position + 1)
        .unwrap_or(0);
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    file.set_len(complete_length as u64)
        .map_err(CommandError::io)?;
    file.sync_data().map_err(CommandError::io)
}

fn read_latest_journal(path: &Path) -> ResearchResult<Option<RecoveryJournalV1>> {
    let metadata = fs::metadata(path).map_err(CommandError::io)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Ok(None);
    }
    let mut reader = BufReader::new(File::open(path).map_err(CommandError::io)?);
    let mut record = Vec::new();
    let mut latest: Option<RecoveryJournalV1> = None;
    loop {
        record.clear();
        let read = reader
            .read_until(b'\n', &mut record)
            .map_err(CommandError::io)?;
        if read == 0 {
            break;
        }
        if !record.ends_with(b"\n") {
            // A crash may tear only the final append. The preceding synced record
            // remains authoritative.
            break;
        }
        let Ok(candidate) =
            serde_json::from_slice::<RecoveryJournalV1>(trim_record_ending(&record))
        else {
            return Ok(None);
        };
        if let Some(previous) = &latest {
            if candidate.recovery_id != previous.recovery_id
                || candidate.run_id != previous.run_id
                || candidate.partial_sample_count < previous.partial_sample_count
                || candidate.partial_event_count < previous.partial_event_count
                || candidate.last_safe_stimulus_position < previous.last_safe_stimulus_position
            {
                return Ok(None);
            }
        }
        latest = Some(candidate);
    }
    Ok(latest)
}

fn open_append(path: &Path) -> ResearchResult<File> {
    OpenOptions::new()
        .append(true)
        .read(true)
        .open(path)
        .map_err(CommandError::io)
}

fn parse_sample_table(
    path: &Path,
    delimiter: u8,
    journal: &RecoveryJournalV1,
) -> ResearchResult<ParsedTable> {
    let file = File::open(path).map_err(CommandError::io)?;
    let mut reader = BufReader::new(file);
    let mut record = Vec::new();
    if reader
        .read_until(b'\n', &mut record)
        .map_err(CommandError::io)?
        == 0
        || !record.ends_with(b"\n")
    {
        return Err(CommandError::invalid_contract(
            "A recovery ratings table has no complete header.",
        ));
    }
    let header_end_offset = record.len() as u64;
    let header =
        parse_delimited_fields(trim_record_ending(&record), delimiter).ok_or_else(|| {
            CommandError::invalid_contract("A recovery ratings table header is malformed.")
        })?;
    if header != sample_headers() {
        return Err(CommandError::invalid_contract(
            "A recovery ratings table has an incompatible schema.",
        ));
    }
    let mut row_digests = Vec::new();
    let mut row_end_offsets = Vec::new();
    let mut monotonic_values = Vec::new();
    let mut offset = header_end_offset;
    loop {
        record.clear();
        let read = reader
            .read_until(b'\n', &mut record)
            .map_err(CommandError::io)?;
        if read == 0 {
            break;
        }
        if !record.ends_with(b"\n") {
            break;
        }
        let Some(fields) = parse_delimited_fields(trim_record_ending(&record), delimiter) else {
            break;
        };
        let sequence = (row_digests.len() as u64).saturating_add(1);
        if fields.len() != sample_headers().len()
            || fields[0] != RESEARCH_SAMPLE_SCHEMA
            || fields[1] != "1"
            || fields[2].parse::<u64>().ok() != Some(sequence)
            || fields[3] != journal.run_id
            || fields[4] != journal.participant_id
            || fields[5].parse::<u32>().ok() != Some(journal.attempt_number)
            || fields[6] != journal.settings_sha256
            || fields[7] != journal.assignment_plan_sha256
        {
            break;
        }
        let Ok(monotonic_ns) = fields[11].parse::<u128>() else {
            break;
        };
        if monotonic_values
            .last()
            .is_some_and(|previous| monotonic_ns <= *previous)
        {
            break;
        }
        let mut digest = Sha256::new();
        for field in &fields {
            digest.update(field.as_bytes());
            digest.update([0]);
        }
        row_digests.push(digest.finalize().into());
        monotonic_values.push(monotonic_ns);
        offset = offset.saturating_add(read as u64);
        row_end_offsets.push(offset);
    }
    Ok(ParsedTable {
        row_digests,
        row_end_offsets,
        header_end_offset,
        monotonic_values,
    })
}

fn parse_delimited_fields(record: &[u8], delimiter: u8) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut field = Vec::new();
    let mut quoted = false;
    let mut index = 0usize;
    while index < record.len() {
        let byte = record[index];
        if quoted {
            if byte == b'"' {
                if record.get(index + 1) == Some(&b'"') {
                    field.push(b'"');
                    index += 2;
                    continue;
                }
                quoted = false;
            } else {
                field.push(byte);
            }
        } else if byte == delimiter {
            fields.push(String::from_utf8(field).ok()?);
            field = Vec::new();
        } else if byte == b'"' {
            if !field.is_empty() {
                return None;
            }
            quoted = true;
        } else {
            field.push(byte);
        }
        index += 1;
    }
    if quoted {
        return None;
    }
    fields.push(String::from_utf8(field).ok()?);
    Some(fields)
}

fn trim_record_ending(record: &[u8]) -> &[u8] {
    record
        .strip_suffix(b"\n")
        .unwrap_or(record)
        .strip_suffix(b"\r")
        .unwrap_or_else(|| record.strip_suffix(b"\n").unwrap_or(record))
}

fn truncate_table_to_rows(
    path: &Path,
    table: &ParsedTable,
    row_count: usize,
) -> ResearchResult<()> {
    let end = row_count
        .checked_sub(1)
        .and_then(|index| table.row_end_offsets.get(index).copied())
        .unwrap_or(table.header_end_offset);
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    file.set_len(end).map_err(CommandError::io)?;
    file.sync_data().map_err(CommandError::io)
}

fn reconcile_events(path: &Path, journal: &RecoveryJournalV1) -> ResearchResult<ReconciledEvents> {
    let file = File::open(path).map_err(CommandError::io)?;
    let mut reader = BufReader::new(file);
    let mut record = Vec::new();
    let mut offset = 0u64;
    let mut event_count = 0u64;
    let mut last_safe_position = 0u32;
    let mut active_position = None;
    let mut interrupted_position = None;
    let mut last_monotonic_ns = 0u128;
    let mut gap_event_count = 0u64;
    let mut missed_slot_count = 0u64;
    loop {
        record.clear();
        let read = reader
            .read_until(b'\n', &mut record)
            .map_err(CommandError::io)?;
        if read == 0 {
            break;
        }
        if !record.ends_with(b"\n") {
            break;
        }
        let line = trim_record_ending(&record);
        let Ok(event) = serde_json::from_slice::<ResearchEventV1>(line) else {
            break;
        };
        let expected_sequence = event_count.saturating_add(1);
        let monotonic = event.monotonic_time_ns.parse::<u128>().ok();
        if event.schema != RESEARCH_EVENT_SCHEMA
            || event.version != 1
            || event.sequence != expected_sequence
            || event.run_id != journal.run_id
            || event.participant_id != journal.participant_id
            || event.attempt_number != journal.attempt_number
            || event.settings_sha256 != journal.settings_sha256
            || event.assignment_plan_sha256 != journal.assignment_plan_sha256
            || monotonic.is_none()
            || (event_count > 0 && monotonic.is_some_and(|value| value <= last_monotonic_ns))
            || event.stimulus_identity.is_some() != event.stimulus_position.is_some()
            || event.stimulus_identity.is_some() != event.media_time_ms.is_some()
            || event
                .stimulus_identity
                .as_ref()
                .is_some_and(|identity| identity.validate().is_err())
            || (event.event_type == ResearchEventTypeV1::TimingGap)
                != event.missed_slot_count.is_some()
            || event.missed_slot_count == Some(0)
        {
            break;
        }
        let position = event.stimulus_position;
        let lifecycle_valid = match event.event_type {
            ResearchEventTypeV1::StimulusStarted => {
                let valid = active_position.is_none()
                    && position == Some(last_safe_position.saturating_add(1));
                if valid {
                    active_position = position;
                    interrupted_position = position;
                }
                valid
            }
            ResearchEventTypeV1::StimulusPaused
            | ResearchEventTypeV1::StimulusResumed
            | ResearchEventTypeV1::InputEdge
            | ResearchEventTypeV1::TimingGap => position == active_position,
            ResearchEventTypeV1::StimulusCompleted => {
                let valid = position == active_position;
                if valid {
                    last_safe_position = position.unwrap_or(last_safe_position);
                    active_position = None;
                    interrupted_position = None;
                }
                valid
            }
            ResearchEventTypeV1::TransitionStarted | ResearchEventTypeV1::TransitionCompleted => {
                active_position.is_none() && position == Some(last_safe_position)
            }
            ResearchEventTypeV1::WriteInterrupted => {
                interrupted_position = position.or(active_position);
                active_position = None;
                true
            }
            ResearchEventTypeV1::StoppedEarly
            | ResearchEventTypeV1::SessionCompleted
            | ResearchEventTypeV1::SessionAborted => false,
            ResearchEventTypeV1::SessionPrepared
            | ResearchEventTypeV1::SessionStarted
            | ResearchEventTypeV1::WriteRecovered
            | ResearchEventTypeV1::RecoveryStarted
            | ResearchEventTypeV1::RecoveryCompleted => position.is_none(),
        };
        if !lifecycle_valid {
            break;
        }
        if event.event_type == ResearchEventTypeV1::TimingGap {
            gap_event_count = gap_event_count.saturating_add(1);
            missed_slot_count =
                missed_slot_count.saturating_add(event.missed_slot_count.unwrap_or_default());
        }
        event_count = expected_sequence;
        last_monotonic_ns = monotonic.unwrap_or_default();
        offset = offset.saturating_add(read as u64);
    }
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    file.set_len(offset).map_err(CommandError::io)?;
    file.sync_data().map_err(CommandError::io)?;
    Ok(ReconciledEvents {
        event_count,
        last_safe_position,
        interrupted_stimulus_position: active_position.or(interrupted_position),
        last_monotonic_ns,
        gap_event_count,
        missed_slot_count,
    })
}

fn load_recovery_journal(
    workspace_root: &Path,
    recovery_id: &str,
) -> ResearchResult<(PathBuf, RecoveryJournalV1)> {
    if Uuid::parse_str(recovery_id).is_err() {
        return Err(CommandError::invalid_contract(
            "Recovery ID must be an opaque UUID returned by the native recovery listing.",
        ));
    }
    let mut match_found = None;
    for entry in fs::read_dir(workspace_root.join("recovery")).map_err(CommandError::io)? {
        let entry = entry.map_err(CommandError::io)?;
        if !entry.file_type().map_err(CommandError::io)?.is_file()
            || !entry
                .file_name()
                .to_string_lossy()
                .ends_with(".journal.json")
        {
            continue;
        }
        let Some(journal) = read_latest_journal(&entry.path())? else {
            continue;
        };
        if journal.recovery_id == recovery_id {
            if match_found.is_some() {
                return Err(CommandError::forbidden(
                    "The recovery ID is ambiguous and cannot be resumed.",
                ));
            }
            match_found = Some((entry.path(), journal));
        }
    }
    match_found.ok_or_else(|| CommandError::forbidden("The recovery ID is unavailable."))
}

fn validate_recovery_journal(
    journal: &RecoveryJournalV1,
    settings: &ResearchSettingsV1,
    plan: &ResolvedAssignmentPlanV1,
) -> ResearchResult<()> {
    validate_participant_id(&journal.participant_id)?;
    validate_participant_code(&journal.participant_code)?;
    if journal.schema != "affect-research-recovery-journal"
        || journal.version != 1
        || Uuid::parse_str(&journal.recovery_id).is_err()
        || Uuid::parse_str(&journal.run_id).is_err()
        || journal.experiment_id != settings.experiment.id
        || journal.age == 0
        || journal.age > 120
        || journal.attempt_number == 0
        || journal.settings_sha256 != settings.canonical_sha256()?
        || journal.assignment_plan_sha256 != plan.plan_hash_sha256
        || journal.last_monotonic_time_ns.parse::<u128>().is_err()
        || journal.started_at.is_empty()
        || !is_safe_component(&journal.session_stem)
    {
        return Err(CommandError::invalid_contract(
            "The recovery journal does not match the supplied frozen run contracts.",
        ));
    }
    Ok(())
}

fn recovery_session_dir(
    workspace_root: &Path,
    journal: &RecoveryJournalV1,
) -> ResearchResult<PathBuf> {
    if !is_safe_component(&journal.experiment_id)
        || !is_safe_component(&journal.participant_id)
        || !is_safe_component(&journal.session_stem)
    {
        return Err(CommandError::forbidden(
            "The recovery journal contains an unsafe output identity.",
        ));
    }
    let output_root = workspace_root
        .join("outputs")
        .canonicalize()
        .map_err(CommandError::io)?;
    let session_dir = output_root
        .join(&journal.experiment_id)
        .join(&journal.participant_id)
        .join(&journal.session_stem)
        .canonicalize()
        .map_err(|_| CommandError::forbidden("The recovery output is unavailable."))?;
    if !session_dir.starts_with(&output_root) || !session_dir.is_dir() {
        return Err(CommandError::forbidden(
            "The recovery output resolves outside the selected workspace.",
        ));
    }
    Ok(session_dir)
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value != "."
        && value != ".."
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
                )
        })
}

fn verify_snapshot(path: &Path, expected: &[u8], label: &str) -> ResearchResult<()> {
    let bytes = fs::read(path).map_err(CommandError::io)?;
    if bytes != expected {
        return Err(CommandError::forbidden(format!(
            "The frozen {label} snapshot does not match the recovery contract."
        )));
    }
    Ok(())
}

fn file_digest(path: &Path) -> ResearchResult<(String, u64)> {
    let mut file = File::open(path).map_err(CommandError::io)?;
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(CommandError::io)?;
        if count == 0 {
            break;
        }
        length = length.saturating_add(count as u64);
        digest.update(&buffer[..count]);
    }
    Ok((format!("{:x}", digest.finalize()), length))
}

fn output_record(
    kind: RunOutputKindV1,
    path: &Path,
    row_count: Option<u64>,
) -> ResearchResult<RunOutputV1> {
    let (sha256, byte_length) = file_digest(path)?;
    Ok(RunOutputV1 {
        kind,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| CommandError::io("An output file name is invalid."))?
            .to_owned(),
        sha256,
        byte_length,
        row_count,
    })
}

fn file_receipt(path: &Path) -> ResearchResult<FinalizedFileReceipt> {
    let (sha256, byte_length) = file_digest(path)?;
    Ok(FinalizedFileReceipt {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("output")
            .to_owned(),
        sha256,
        byte_length,
    })
}

fn scan_recoveries(workspace_root: &Path) -> ResearchResult<RecoveryListing> {
    let recovery_root = workspace_root.join("recovery");
    let mut recoveries = Vec::new();
    let mut corrupt_recovery_ids = Vec::new();
    for entry in fs::read_dir(recovery_root).map_err(CommandError::io)? {
        let entry = entry.map_err(CommandError::io)?;
        if !entry.file_type().map_err(CommandError::io)?.is_file()
            || !entry
                .file_name()
                .to_string_lossy()
                .ends_with(".journal.json")
        {
            continue;
        }
        let Some(journal) = read_latest_journal(&entry.path())? else {
            corrupt_recovery_ids.push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
            continue;
        };
        if journal.schema != "affect-research-recovery-journal" || journal.version != 1 {
            corrupt_recovery_ids.push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
            continue;
        }
        recoveries.push(RecoverySummary {
            recovery_id: journal.recovery_id,
            run_id: journal.run_id,
            experiment_id: journal.experiment_id,
            participant_id: journal.participant_id,
            attempt_number: journal.attempt_number,
            last_safe_stimulus_position: journal.last_safe_stimulus_position,
            partial_sample_count: journal.partial_sample_count,
            settings_sha256: journal.settings_sha256,
            assignment_plan_sha256: journal.assignment_plan_sha256,
            playback_mode: journal.playback_mode,
            playback_qualification: journal.playback_qualification,
        });
    }
    recoveries.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    corrupt_recovery_ids.sort();
    Ok(RecoveryListing {
        recoveries,
        corrupt_recovery_ids,
    })
}

fn corrupt_recovery_id(file_name: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(file_name.as_bytes()));
    format!("corrupt-{}", &digest[..16])
}

fn reconstruct_participant_states(
    workspace_root: &Path,
    settings: &ResearchSettingsV1,
    active: &RunStatus,
) -> ResearchResult<Vec<ParticipantTileStatus>> {
    let settings_sha256 = settings.canonical_sha256()?;
    let assignment_plan_sha256 = resolve_assignment_plan_v1(settings)
        .ok()
        .map(|plan| plan.plan_hash_sha256);
    let width = settings
        .experiment
        .participant_count
        .to_string()
        .len()
        .max(3);
    let journals = scan_recoveries(workspace_root)?.recoveries;
    let mut tiles = Vec::with_capacity(settings.experiment.participant_count as usize);
    for number in 1..=settings.experiment.participant_count {
        let participant_id = format!("P{number:0width$}");
        let mut latest_attempt = None;
        let mut latest_state = ParticipantState::Available;
        let participant_root = workspace_root
            .join("outputs")
            .join(&settings.experiment.id)
            .join(&participant_id);
        if participant_root.is_dir() {
            for entry in fs::read_dir(&participant_root).map_err(CommandError::io)? {
                let entry = entry.map_err(CommandError::io)?;
                if !entry.file_type().map_err(CommandError::io)?.is_dir() {
                    continue;
                }
                let manifest_path = entry.path().join("manifest.json");
                let (attempt, state) = match fs::read(&manifest_path) {
                    Ok(bytes) if bytes.len() <= 5 * 1024 * 1024 => {
                        match serde_json::from_slice::<ResearchRunManifestV2>(&bytes) {
                            Ok(manifest)
                                if manifest.experiment_id == settings.experiment.id
                                    && manifest.participant_id == participant_id
                                    && manifest.validate().is_ok() =>
                            {
                                (
                                    manifest.attempt_number,
                                    match manifest.completion_status {
                                        CompletionStatusV1::Completed => ParticipantState::Complete,
                                        CompletionStatusV1::Partial => ParticipantState::Partial,
                                    },
                                )
                            }
                            _ => (
                                attempt_from_stem(&entry.file_name().to_string_lossy()),
                                ParticipantState::Partial,
                            ),
                        }
                    }
                    _ => (
                        attempt_from_stem(&entry.file_name().to_string_lossy()),
                        ParticipantState::Partial,
                    ),
                };
                if latest_attempt.is_none_or(|current| attempt >= current) {
                    latest_attempt = Some(attempt);
                    latest_state = state;
                }
            }
        }
        for journal in journals.iter().filter(|journal| {
            journal.experiment_id == settings.experiment.id
                && journal.participant_id == participant_id
        }) {
            if latest_attempt.is_none_or(|current| journal.attempt_number >= current) {
                latest_attempt = Some(journal.attempt_number);
                latest_state = ParticipantState::Partial;
            }
        }
        if participant_attempt_is_locked(&participant_root)? {
            latest_state = ParticipantState::Active;
        }
        if active.active
            && active.participant_id.as_deref() == Some(participant_id.as_str())
            && active.attempt_number.is_some()
        {
            latest_attempt = active.attempt_number;
            latest_state = ParticipantState::Active;
        }
        let recoverable = latest_state == ParticipantState::Partial
            && latest_attempt.is_some_and(|attempt| {
                journals.iter().any(|journal| {
                    journal.experiment_id == settings.experiment.id
                        && journal.participant_id == participant_id
                        && journal.attempt_number == attempt
                        && journal.settings_sha256.as_str() == settings_sha256
                        && assignment_plan_sha256
                            .as_ref()
                            .is_some_and(|hash| journal.assignment_plan_sha256.as_str() == hash)
                })
            });
        tiles.push(ParticipantTileStatus {
            participant_id,
            state: latest_state,
            latest_attempt_number: latest_attempt,
            recoverable,
        });
    }
    Ok(tiles)
}

fn participant_attempt_is_locked(participant_root: &Path) -> ResearchResult<bool> {
    let path = participant_root.join(".affect-research-attempt.lock");
    if !path.is_file() {
        return Ok(false);
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            FileExt::unlock(&file).map_err(CommandError::io)?;
            Ok(false)
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(_) => Err(CommandError::io(
            "The participant attempt lock could not be inspected.",
        )),
    }
}

fn attempt_from_stem(stem: &str) -> u32 {
    stem.rsplit_once("_R")
        .and_then(|(_, value)| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_plan(settings: &ResearchSettingsV1) -> ResolvedAssignmentPlanV1 {
        let settings_sha256 = settings.canonical_sha256().unwrap();
        let mut plan = ResolvedAssignmentPlanV1 {
            schema: RESOLVED_ASSIGNMENT_PLAN_SCHEMA.to_owned(),
            version: 1,
            algorithm_version: AllocationAlgorithmV1::BalancedV1,
            seed: settings.stimuli.seed.clone(),
            condition_order: ConditionOrderV1::Williams,
            settings_sha256,
            participant_ids: vec!["P001".to_owned()],
            stimuli: settings.stimuli.items.clone(),
            pools: settings.stimuli.pools.clone(),
            assignments: vec![ParticipantAssignmentV1 {
                participant_id: "P001".to_owned(),
                condition_order: vec!["pool-a".to_owned()],
                slots: vec![AssignmentSlotV1 {
                    position: 1,
                    pool_id: "pool-a".to_owned(),
                    pool_position: 1,
                    stimulus_id: "video-a".to_owned(),
                }],
            }],
            exposure_counts: vec![StimulusExposureV1 {
                stimulus_id: "video-a".to_owned(),
                total: 1,
                position_counts: vec![1],
            }],
            plan_hash_sha256: String::new(),
        };
        plan.plan_hash_sha256 = canonical_sha256(&plan, &["planHashSha256"]).unwrap();
        plan
    }

    fn test_settings(video_hash: &str, workspace_file_id: &str) -> ResearchSettingsV1 {
        let mut value =
            serde_json::to_value(crate::research_contracts::tests::default_settings()).unwrap();
        value["experiment"]["participantCount"] = serde_json::json!(1);
        value["experiment"]["samplingFrequencyHz"] = serde_json::json!(130);
        let logical_path = format!("stimuli/.workspace/{workspace_file_id}");
        value["stimuli"]["items"] = serde_json::json!([{
            "stimulusId":"video-a","title":"Video A","source":{
                "kind":"workspaceFile","relativePath":logical_path,
                "mimeType":"video/mp4","sha256":video_hash,"byteLength":5,"durationMs":1000
            }
        }]);
        value["stimuli"]["pools"] = serde_json::json!([{
            "poolId":"pool-a","label":"Condition A","videosPerParticipant":1,
            "stimulusIds":["video-a"]
        }]);
        value["input"] = serde_json::json!({
            "schema":INPUT_BINDING_SCHEMA,"version":1,"preset":"pointerGrid","kind":"absolute",
            "stepSize":null,"directions":null,"axes":{
                "x":{"kind":"pointerAxis","axis":"x","invert":false},
                "y":{"kind":"pointerAxis","axis":"y","invert":true}
            }
        });
        value["output"] = serde_json::json!({"csv":true,"tsv":true});
        serde_json::from_value::<ResearchSettingsV1>(value)
            .unwrap()
            .normalize_and_validate()
            .unwrap()
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "affect-research-runtime-{label}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn participant_code_requires_two_uppercase_safe_graphemes() {
        assert_eq!(validate_participant_code("EM").unwrap(), "EM");
        assert_eq!(validate_participant_code("ËÅ").unwrap(), "ËÅ");
        assert!(validate_participant_code("Em").is_err());
        assert!(validate_participant_code("E_M").is_err());
    }

    #[test]
    fn csv_and_tsv_share_an_identical_column_contract() {
        let headers = sample_headers();
        assert_eq!(headers.len(), 37);
        assert_eq!(headers[0], "schema");
        assert_eq!(headers[36], "feedbackVisible");
    }

    #[test]
    fn recovery_journal_rejects_unknown_fields() {
        let value = serde_json::json!({
            "schema":"affect-research-recovery-journal","version":1,
            "recoveryId":"r","runId":"run","experimentId":"experiment",
            "participantId":"P001","participantCode":"AB","age":20,"gender":"X",
            "handedness":"R","attemptNumber":1,"sessionStem":"stem",
            "settingsSha256":"0".repeat(64),"assignmentPlanSha256":"1".repeat(64),
            "startedAt":"2026-01-01T00:00:00Z","partialSampleCount":0,
            "partialEventCount":0,"lastSafeStimulusPosition":0,
            "interruptedStimulusPosition":null,"lastMonotonicTimeNs":"0",
            "gapEventCount":0,"missedSlotCount":0,"unexpected":true
        });
        assert!(serde_json::from_value::<RecoveryJournalV1>(value).is_err());
    }

    #[test]
    fn affect_updates_reject_nan_and_out_of_range_values() {
        assert!(validate_affect_update(&AffectStateUpdate {
            valence: f64::NAN,
            arousal: 0.0,
            input_active: false,
            input_kind: InputKindV1::Absolute,
        })
        .is_err());
        assert!(validate_affect_update(&AffectStateUpdate {
            valence: 0.0,
            arousal: 0.0,
            input_active: true,
            input_kind: InputKindV1::Digital,
        })
        .is_err());
        assert!(validate_affect_update(&AffectStateUpdate {
            valence: 1.1,
            arousal: 0.0,
            input_active: false,
            input_kind: InputKindV1::Absolute,
        })
        .is_err());
    }

    #[test]
    fn transition_duration_matches_the_shared_deterministic_policy() {
        assert_eq!(
            transition_duration_ms(
                &BetweenVideosV1::Fixed { duration_ms: 750 },
                "seed",
                "P001",
                1,
            ),
            Some(750)
        );
        assert_eq!(
            transition_duration_ms(&BetweenVideosV1::ContinueWhenReady, "seed", "P001", 1,),
            None
        );
        assert_eq!(
            transition_duration_ms(
                &BetweenVideosV1::Jitter {
                    durations_ms: vec![100, 200, 300],
                },
                "000102030405060708090a0b0c0d0e0f",
                "P001",
                1,
            ),
            Some(300)
        );
    }

    #[test]
    fn corrupt_recovery_is_isolated_and_reported_without_a_path() {
        let base = temporary_directory("corrupt-recovery");
        fs::create_dir(base.join("recovery")).unwrap();
        fs::write(
            base.join("recovery").join("private-name.journal.json"),
            b"{",
        )
        .unwrap();
        let listing = scan_recoveries(&base).unwrap();
        assert!(listing.recoveries.is_empty());
        assert_eq!(listing.corrupt_recovery_ids.len(), 1);
        assert!(!listing.corrupt_recovery_ids[0].contains("private"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn participant_attempt_lock_is_exclusive_and_released_with_its_handle() {
        let base = temporary_directory("attempt-lock");
        let first = acquire_attempt_lock(&base).unwrap();
        assert!(acquire_attempt_lock(&base).is_err());
        drop(first);
        assert!(acquire_attempt_lock(&base).is_ok());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn native_run_writes_parity_tables_manifest_and_no_names() {
        let base = temporary_directory("complete");
        let workspace = Arc::new(WorkspaceService::new(base.join("app-data")).unwrap());
        let selected = base.join("workspace");
        fs::create_dir(&selected).unwrap();
        let workspace_status = workspace.select(selected.clone()).unwrap();
        fs::write(selected.join("stimuli").join("video-a.mp4"), b"video").unwrap();
        let scan = workspace
            .rescan(workspace_status.workspace_id.as_deref().unwrap())
            .unwrap();
        let workspace_file_id = scan.stimuli[0].workspace_file_id.clone();
        workspace.mark_first_scanned_verified(1_000.0);
        let video_hash = format!("{:x}", Sha256::digest(b"video"));
        let settings = test_settings(&video_hash, &workspace_file_id);
        let plan = test_plan(&settings);
        let runtime = ResearchRuntime::new(Arc::clone(&workspace));
        let qualified = runtime.start_run(StartRunRequest {
            workspace_id: workspace_status.workspace_id.clone().unwrap(),
            settings: settings.clone(),
            assignment_plan: plan.clone(),
            participant: TransientParticipant {
                participant_id: "P001".to_owned(),
                participant_code: "EM".to_owned(),
                age: 27,
                gender: GenderCodeV1::W,
                handedness: HandednessCodeV1::R,
            },
            workspace_files: vec![WorkspaceFileBinding {
                stimulus_id: "video-a".to_owned(),
                workspace_file_id: workspace_file_id.clone(),
            }],
            rerun_confirmed: false,
            playback_mode: PlaybackMode::NativeLibvlc,
        });
        assert_eq!(qualified.unwrap_err().code, "native_media_unavailable");
        assert!(!selected.join("outputs").join("video-affect-study").exists());
        let receipt = runtime
            .start_run(StartRunRequest {
                workspace_id: workspace_status.workspace_id.clone().unwrap(),
                settings: settings.clone(),
                assignment_plan: plan.clone(),
                participant: TransientParticipant {
                    participant_id: "P001".to_owned(),
                    participant_code: "EM".to_owned(),
                    age: 27,
                    gender: GenderCodeV1::W,
                    handedness: HandednessCodeV1::R,
                },
                workspace_files: vec![WorkspaceFileBinding {
                    stimulus_id: "video-a".to_owned(),
                    workspace_file_id: workspace_file_id.clone(),
                }],
                rerun_confirmed: false,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        assert_eq!(receipt.playback_mode, PlaybackMode::UnqualifiedWebview);
        assert_eq!(
            receipt.playback_qualification,
            PlaybackQualification::Unqualified
        );
        runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        runtime
            .update_affect(AffectStateUpdate {
                valence: 0.5,
                arousal: -0.25,
                input_active: true,
                input_kind: InputKindV1::Absolute,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(40));
        let finalized = runtime.finish(FinishOutcome::StopEarly).unwrap();
        assert_eq!(finalized.completion_status, CompletionStatusV1::Partial);

        let session_dir = selected
            .join("outputs")
            .join("video-affect-study")
            .join("P001")
            .join(&receipt.session_stem);
        let manifest: ResearchRunManifestV2 =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert!(manifest.timing.sample_count >= 2);
        assert_eq!(manifest.participant_code, "EM");
        assert_eq!(manifest.completion_status, CompletionStatusV1::Partial);
        let csv = fs::read_to_string(session_dir.join("ratings.csv")).unwrap();
        let tsv = fs::read_to_string(session_dir.join("ratings.tsv")).unwrap();
        assert!(fs::read_to_string(session_dir.join("events.jsonl"))
            .unwrap()
            .contains("playback-webview-unqualified"));
        assert_eq!(csv.lines().count(), tsv.lines().count());
        assert_eq!(
            csv.lines().next().unwrap(),
            &tsv.lines().next().unwrap().replace('\t', ",")
        );
        for entry in fs::read_dir(&session_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let content = fs::read(&path).unwrap();
                let text = String::from_utf8_lossy(&content);
                assert!(!text.contains("Anne"));
                assert!(!text.contains("Müller"));
            }
        }
        assert_eq!(fs::read_dir(selected.join("recovery")).unwrap().count(), 0);
        let terminal_tiles = runtime
            .participant_states(
                workspace_status.workspace_id.as_deref().unwrap(),
                settings.clone(),
            )
            .unwrap();
        assert_eq!(terminal_tiles[0].state, ParticipantState::Partial);
        assert!(!terminal_tiles[0].recoverable);

        let rerun = runtime.start_run(StartRunRequest {
            workspace_id: workspace_status.workspace_id.unwrap(),
            settings,
            assignment_plan: plan,
            participant: TransientParticipant {
                participant_id: "P001".to_owned(),
                participant_code: "EM".to_owned(),
                age: 27,
                gender: GenderCodeV1::W,
                handedness: HandednessCodeV1::R,
            },
            workspace_files: vec![WorkspaceFileBinding {
                stimulus_id: "video-a".to_owned(),
                workspace_file_id,
            }],
            rerun_confirmed: false,
            playback_mode: PlaybackMode::UnqualifiedWebview,
        });
        assert!(rerun.is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interruption_stays_recoverable_and_resume_reconciles_corrupt_tails() {
        let base = temporary_directory("resume");
        let workspace = Arc::new(WorkspaceService::new(base.join("app-data")).unwrap());
        let selected = base.join("workspace");
        fs::create_dir(&selected).unwrap();
        let workspace_status = workspace.select(selected.clone()).unwrap();
        let workspace_id = workspace_status.workspace_id.clone().unwrap();
        fs::write(selected.join("stimuli").join("video-a.mp4"), b"video").unwrap();
        let scan = workspace.rescan(&workspace_id).unwrap();
        let workspace_file_id = scan.stimuli[0].workspace_file_id.clone();
        workspace.mark_first_scanned_verified(1_000.0);
        let settings = test_settings(
            &format!("{:x}", Sha256::digest(b"video")),
            &workspace_file_id,
        );
        let plan = test_plan(&settings);
        let runtime = ResearchRuntime::new(Arc::clone(&workspace));
        let started = runtime
            .start_run(StartRunRequest {
                workspace_id: workspace_id.clone(),
                settings: settings.clone(),
                assignment_plan: plan.clone(),
                participant: TransientParticipant {
                    participant_id: "P001".to_owned(),
                    participant_code: "EM".to_owned(),
                    age: 27,
                    gender: GenderCodeV1::W,
                    handedness: HandednessCodeV1::R,
                },
                workspace_files: vec![WorkspaceFileBinding {
                    stimulus_id: "video-a".to_owned(),
                    workspace_file_id: workspace_file_id.clone(),
                }],
                rerun_confirmed: false,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        let live_recovery = runtime.list_recoveries(&workspace_id).unwrap();
        assert!(live_recovery.recoveries[0].partial_sample_count > 0);
        runtime.shutdown();

        let interrupted_tiles = runtime
            .participant_states(&workspace_id, settings.clone())
            .unwrap();
        assert_eq!(interrupted_tiles[0].state, ParticipantState::Partial);
        assert!(interrupted_tiles[0].recoverable);

        let session_dir = selected
            .join("outputs")
            .join("video-affect-study")
            .join("P001")
            .join(&started.session_stem);
        assert!(!session_dir.join("manifest.json").exists());
        assert!(session_dir.join("ratings.csv.partial").exists());
        assert!(fs::read_to_string(session_dir.join("events.jsonl"))
            .unwrap()
            .contains("writeInterrupted"));
        for relative in ["ratings.csv.partial", "ratings.tsv.partial"] {
            OpenOptions::new()
                .append(true)
                .open(session_dir.join(relative))
                .unwrap()
                .write_all(b"corrupt-tail")
                .unwrap();
        }
        OpenOptions::new()
            .append(true)
            .open(session_dir.join("events.jsonl"))
            .unwrap()
            .write_all(b"{\"corrupt\"")
            .unwrap();
        let journal_path = fs::read_dir(selected.join("recovery"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        OpenOptions::new()
            .append(true)
            .open(journal_path)
            .unwrap()
            .write_all(b"{\"torn-final-checkpoint\"")
            .unwrap();

        let listing = runtime.list_recoveries(&workspace_id).unwrap();
        assert_eq!(listing.recoveries.len(), 1);
        let resumed = runtime
            .resume_run(ResumeRunRequest {
                workspace_id: workspace_id.clone(),
                recovery_id: listing.recoveries[0].recovery_id.clone(),
                settings: settings.clone(),
                assignment_plan: plan,
                workspace_files: vec![WorkspaceFileBinding {
                    stimulus_id: "video-a".to_owned(),
                    workspace_file_id,
                }],
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        assert_eq!(resumed.run_id, started.run_id);
        assert!(resumed.resumed);
        assert_eq!(resumed.resume_at_stimulus_position, Some(1));
        runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 1_000.0,
            })
            .unwrap();
        runtime.finish(FinishOutcome::Completed).unwrap();

        let manifest: ResearchRunManifestV2 =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.completion_status, CompletionStatusV1::Completed);
        assert!(manifest.recovery.resumed);
        assert_eq!(
            manifest.recovery.source_run_id.as_deref(),
            Some(started.run_id.as_str())
        );
        assert_eq!(manifest.recovery.restarted_stimulus_ids, ["video-a"]);
        let csv = fs::read_to_string(session_dir.join("ratings.csv")).unwrap();
        let tsv = fs::read_to_string(session_dir.join("ratings.tsv")).unwrap();
        assert!(!csv.contains("corrupt-tail"));
        assert!(!tsv.contains("corrupt-tail"));
        assert_eq!(csv.lines().count(), tsv.lines().count());
        assert_eq!(
            runtime
                .list_recoveries(&workspace_id)
                .unwrap()
                .recoveries
                .len(),
            0
        );
        let completed_tiles = runtime.participant_states(&workspace_id, settings).unwrap();
        assert_eq!(completed_tiles[0].state, ParticipantState::Complete);
        assert!(!completed_tiles[0].recoverable);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn media_failure_stops_sampling_and_retains_a_recoverable_boundary() {
        let base = temporary_directory("media-failure");
        let workspace = Arc::new(WorkspaceService::new(base.join("app-data")).unwrap());
        let selected = base.join("workspace");
        fs::create_dir(&selected).unwrap();
        let workspace_status = workspace.select(selected.clone()).unwrap();
        let workspace_id = workspace_status.workspace_id.unwrap();
        fs::write(selected.join("stimuli").join("video-a.mp4"), b"video").unwrap();
        let scan = workspace.rescan(&workspace_id).unwrap();
        let workspace_file_id = scan.stimuli[0].workspace_file_id.clone();
        workspace.mark_first_scanned_verified(1_000.0);
        let settings = test_settings(
            &format!("{:x}", Sha256::digest(b"video")),
            &workspace_file_id,
        );
        let plan = test_plan(&settings);
        let runtime = ResearchRuntime::new(Arc::clone(&workspace));
        let started = runtime
            .start_run(StartRunRequest {
                workspace_id: workspace_id.clone(),
                settings: settings.clone(),
                assignment_plan: plan,
                participant: TransientParticipant {
                    participant_id: "P001".to_owned(),
                    participant_code: "EM".to_owned(),
                    age: 27,
                    gender: GenderCodeV1::W,
                    handedness: HandednessCodeV1::R,
                },
                workspace_files: vec![WorkspaceFileBinding {
                    stimulus_id: "video-a".to_owned(),
                    workspace_file_id,
                }],
                rerun_confirmed: false,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(30));
        let failure = runtime
            .report_media_failure(MediaPlaybackFailureReport {
                reason: MediaPlaybackFailureReason::Decode,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 10.0,
            })
            .unwrap();
        assert_eq!(failure.run_id, started.run_id);
        assert_eq!(failure.failure_code, "media-decode");
        assert_eq!(failure.interrupted_stimulus_position, Some(1));
        assert!(runtime
            .set_stimulus_state(StimulusStateUpdate {
                lifecycle: StimulusLifecycle::Paused,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 10.0,
            })
            .is_err());
        let listing = runtime.list_recoveries(&workspace_id).unwrap();
        assert_eq!(listing.recoveries.len(), 1);
        assert_eq!(listing.recoveries[0].recovery_id, failure.recovery_id);
        assert_eq!(
            listing.recoveries[0].playback_qualification,
            PlaybackQualification::Unqualified
        );
        let events = fs::read_to_string(
            selected
                .join("outputs")
                .join("video-affect-study")
                .join("P001")
                .join(started.session_stem)
                .join("events.jsonl"),
        )
        .unwrap();
        assert!(events.contains("media-decode"));
        let tiles = runtime.participant_states(&workspace_id, settings).unwrap();
        assert_eq!(tiles[0].state, ParticipantState::Partial);
        assert!(tiles[0].recoverable);
        fs::remove_dir_all(base).unwrap();
    }
}
