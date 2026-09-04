use crate::research_contracts::*;
use crate::research_error::{CommandError, ResearchResult};
use crate::research_input::{NativeDigitalInput, ResearchInputService};
use crate::research_lsl::{LslService, LslState};
use crate::research_native_media::{NativeMediaService, PlaybackMode, PlaybackQualification};
use crate::research_timing::DeadlineClock;
use crate::research_workspace::WorkspaceService;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
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
const RUN_EVIDENCE_PERSISTENCE_ERROR: &str = "run_evidence_persistence_failed";
const RUN_EVIDENCE_PERSISTENCE_FAILURE: &str = "stimulus-evidence-persistence-failed";
const COMPLETION_EARLY_TOLERANCE_MS: f64 = 1_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRunRequest {
    pub workspace_id: String,
    pub settings: ResearchSettingsV1,
    pub assignment_plan: ResolvedAssignmentPlanV1,
    pub participant: TransientParticipant,
    pub workspace_files: Vec<WorkspaceFileBinding>,
    pub rerun_confirmed: bool,
    pub input_test_receipt_id: String,
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
    pub input_test_receipt_id: String,
    #[serde(default)]
    pub playback_mode: PlaybackMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeRecoveryRequest {
    pub workspace_id: String,
    pub recovery_id: String,
    pub settings: ResearchSettingsV1,
    pub assignment_plan: ResolvedAssignmentPlanV1,
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
    pub run_id: String,
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
    pub run_id: String,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeReceipt {
    pub run_id: String,
    pub participant_id: String,
    pub attempt_number: u32,
    pub completion_status: CompletionStatusV1,
    pub output_receipt_id: String,
    pub files: Vec<FinalizedFileReceipt>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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
    pub finalization_pending: bool,
    pub pending_completion_status: Option<CompletionStatusV1>,
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
    input: Arc<ResearchInputService>,
    active: Mutex<Option<ActiveRun>>,
}

struct ActiveRun {
    run_id: String,
    playback_mode: PlaybackMode,
    sender: SyncSender<RunMessage>,
    status: Arc<Mutex<RunStatus>>,
    worker: Option<JoinHandle<()>>,
    input_authority_id: String,
}

enum RunMessage {
    Stimulus(StimulusStateUpdate, mpsc::Sender<ResearchResult<()>>),
    DigitalInput(NativeDigitalInput),
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
        Self::with_services(
            workspace,
            Arc::new(NativeMediaService::unavailable_for_tests()),
            Arc::new(ResearchInputService::for_tests()),
        )
    }

    pub fn with_services(
        workspace: Arc<WorkspaceService>,
        native_media: Arc<NativeMediaService>,
        input: Arc<ResearchInputService>,
    ) -> Self {
        Self {
            workspace,
            native_media,
            input,
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
        let input_authority_id = self.input.prepare_run(
            settings.input.clone(),
            &request.input_test_receipt_id,
            move |input| {
                let _ = native_sender.try_send(RunMessage::DigitalInput(input));
            },
        )?;

        let prepared = match self
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
            }) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.input.end_run(&input_authority_id);
                return Err(error);
            }
        };
        let receipt = prepared.receipt.clone();
        let status = Arc::new(Mutex::new(prepared.initial_status()));
        let worker_status = Arc::clone(&status);
        let worker = match thread::Builder::new()
            .name("affect-research-writer".to_owned())
            .spawn(move || run_worker(prepared, receiver, worker_status))
        {
            Ok(worker) => worker,
            Err(error) => {
                self.input.end_run(&input_authority_id);
                return Err(CommandError::io(error));
            }
        };
        *active = Some(ActiveRun {
            run_id: receipt.run_id.clone(),
            playback_mode: receipt.playback_mode,
            sender,
            status,
            worker: Some(worker),
            input_authority_id,
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
        let (sender, receiver) = mpsc::sync_channel(512);
        let native_sender = sender.clone();
        let input_authority_id = self.input.prepare_run(
            settings.input.clone(),
            &request.input_test_receipt_id,
            move |input| {
                let _ = native_sender.try_send(RunMessage::DigitalInput(input));
            },
        )?;
        let prepared = match self
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
            }) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.input.end_run(&input_authority_id);
                return Err(error);
            }
        };
        let receipt = prepared.receipt.clone();
        let status = Arc::new(Mutex::new(prepared.initial_status()));
        let worker_status = Arc::clone(&status);
        let worker = match thread::Builder::new()
            .name("affect-research-writer".to_owned())
            .spawn(move || run_worker(prepared, receiver, worker_status))
        {
            Ok(worker) => worker,
            Err(error) => {
                self.input.end_run(&input_authority_id);
                return Err(CommandError::io(error));
            }
        };
        *active = Some(ActiveRun {
            run_id: receipt.run_id.clone(),
            playback_mode: receipt.playback_mode,
            sender,
            status,
            worker: Some(worker),
            input_authority_id,
        });
        Ok(receipt)
    }

    /// Complete an already-durable terminal transaction after reload. This path
    /// never prepares media, input, sampling, or LSL because the attempt has no
    /// remaining acquisition work.
    pub fn finalize_recovery(
        &self,
        request: FinalizeRecoveryRequest,
    ) -> ResearchResult<FinalizeReceipt> {
        let active = self.lock_active();
        if active.is_some() {
            return Err(CommandError::run_active());
        }
        let settings = request.settings.normalize_and_validate()?;
        let settings_sha256 = settings.canonical_sha256()?;
        request.assignment_plan.validate(&settings_sha256)?;
        validate_plan_matches_settings(&request.assignment_plan, &settings)?;
        self.workspace
            .with_workspace(&request.workspace_id, |root, _| {
                finalize_recovery_at_root(
                    root,
                    &request.recovery_id,
                    &settings,
                    &request.assignment_plan,
                )
            })
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

    /// Accept a playback lifecycle projection from the renderer only for the
    /// deliberately selected, permanently unqualified WebView player.  A
    /// qualified native run must be driven by the private native-media actor
    /// path and may never treat an IPC caller as playback authority.
    pub fn set_webview_stimulus_state(&self, update: StimulusStateUpdate) -> ResearchResult<()> {
        validate_run_id(&update.run_id)?;
        if !update.media_time_ms.is_finite() || update.media_time_ms < 0.0 {
            return Err(CommandError::invalid_contract(
                "Stimulus media time must be a finite non-negative number.",
            ));
        }
        let lifecycle = update.lifecycle;
        let begins_sampling = matches!(
            lifecycle,
            StimulusLifecycle::Started | StimulusLifecycle::Resumed
        );
        let (reply_receiver, input_authority_id) = {
            let active = self.lock_active();
            let run = active.as_ref().ok_or_else(CommandError::no_active_run)?;
            authorize_run_id(&run.run_id, &update.run_id)?;
            authorize_webview_media_mode(Some(run.playback_mode))?;
            let input_authority_id = run.input_authority_id.clone();
            if begins_sampling {
                self.input.ensure_run_ready(&input_authority_id)?;
            }
            let (reply_sender, reply_receiver) = mpsc::channel();
            run.sender
                .try_send(RunMessage::Stimulus(update, reply_sender))
                .map_err(|_| CommandError::io("The native run command queue is unavailable."))?;
            (reply_receiver, input_authority_id)
        };
        let result = reply_receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| CommandError::io("The stimulus lifecycle update timed out."))?;
        if result.is_ok() {
            self.input
                .set_run_accepting(&input_authority_id, begins_sampling)?;
        } else if result
            .as_ref()
            .is_err_and(|error| error.code == RUN_EVIDENCE_PERSISTENCE_ERROR)
        {
            let _ = self.input.set_run_accepting(&input_authority_id, false);
        }
        result
    }

    pub fn finish(&self, run_id: &str, outcome: FinishOutcome) -> ResearchResult<FinalizeReceipt> {
        validate_run_id(run_id)?;
        let mut active = self.lock_active();
        let Some(run) = active.as_ref() else {
            return Err(CommandError::no_active_run());
        };
        authorize_run_id(&run.run_id, run_id)?;
        let (reply_sender, reply_receiver) = mpsc::channel();
        if run
            .sender
            .send(RunMessage::Finish(outcome, reply_sender))
            .is_err()
        {
            if let Some(mut failed) = active.take() {
                self.input.end_run(&failed.input_authority_id);
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
            self.input.end_run(&run.input_authority_id);
            if let Some(worker) = run.worker.take() {
                let _ = worker.join();
            }
        }
        result
    }

    /// Accept renderer media failure evidence only for the explicit WebView
    /// fallback.  Native actor failures will enter through a non-IPC adapter
    /// once the separately approved libVLC boundary exists.
    pub fn report_webview_media_failure(
        &self,
        report: MediaPlaybackFailureReport,
    ) -> ResearchResult<MediaPlaybackFailureReceipt> {
        validate_run_id(&report.run_id)?;
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
        authorize_run_id(&run.run_id, &report.run_id)?;
        authorize_webview_media_mode(Some(run.playback_mode))?;
        let (reply_sender, reply_receiver) = mpsc::channel();
        if run
            .sender
            .send(RunMessage::MediaFailure(report, reply_sender))
            .is_err()
        {
            if let Some(mut failed) = active.take() {
                self.input.end_run(&failed.input_authority_id);
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
        self.input.end_run(&run.input_authority_id);
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

    fn interrupt(&self) -> ResearchResult<()> {
        let mut active = self.lock_active();
        let Some(mut run) = active.take() else {
            return Ok(());
        };
        self.input.end_run(&run.input_authority_id);
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
        let output_directories = RunOutputDirectories::prepare(
            workspace_root,
            &settings.experiment.id,
            &participant.participant_id,
        )?;
        let participant_root = output_directories.participant.path.clone();
        let attempt_lock = acquire_attempt_lock(&participant_root)?;
        output_directories.revalidate()?;
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
        let session_dir = output_directories.create_session(&session_stem)?;
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
            &output_directories.workspace.path,
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
        let (mut files, reconciled) = RunFiles::resume(
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
        if completed_boundary_is_durable(&session_dir, &files.journal, &plan)? {
            return Err(CommandError::forbidden(
                "The completed recovery boundary must use finalize-only recovery; no stimulus may be replayed.",
            ));
        }
        let restarted_stimulus_id = reconciled
            .interrupted_stimulus_position
            .and_then(|position| {
                assignment
                    .slots
                    .get(position.saturating_sub(1) as usize)
                    .map(|slot| slot.stimulus_id.clone())
            });
        let mut recovery = files.journal.recovery.clone();
        recovery.resumed = true;
        recovery.source_run_id = Some(journal.run_id.clone());
        if let Some(stimulus_id) = restarted_stimulus_id {
            if !recovery.restarted_stimulus_ids.contains(&stimulus_id) {
                recovery.restarted_stimulus_ids.push(stimulus_id);
            }
        }
        files.update_recovery_summary(recovery.clone())?;
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
            recovery,
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
            Ok(RunMessage::Stimulus(update, reply)) => {
                let (result, evidence_failure) = worker.apply_stimulus_message(update);
                if evidence_failure {
                    worker.fail(RUN_EVIDENCE_PERSISTENCE_FAILURE);
                }
                let _ = reply.send(result);
                if evidence_failure {
                    return;
                }
            }
            Ok(RunMessage::DigitalInput(input)) => {
                if worker.apply_digital_input(input).is_err() {
                    worker.fail("input-edge-invalid");
                    return;
                }
            }
            Ok(RunMessage::Finish(outcome, reply)) => {
                let previous_phase = lock(&worker.status).phase;
                lock(&worker.status).phase = RunPhase::Finalizing;
                let result = worker.finalize(outcome);
                let should_exit = result.is_ok();
                if !should_exit && worker.finalization.is_none() {
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
    monotonic_offset_ns: u128,
    recovery: RecoverySummaryV1,
    resumed: bool,
    finalization: Option<WorkerFinalization>,
}

#[derive(Clone, Copy)]
struct AffectState {
    current_x: f64,
    current_y: f64,
    target_x: f64,
    target_y: f64,
    anchor: Instant,
    impulse_active_until: Instant,
}

#[derive(Clone)]
struct ActiveStimulus {
    identity: SampleStimulusIdentityV1,
    position: u32,
    media_anchor_ms: f64,
    media_anchor_at: Instant,
}

#[derive(Clone)]
struct WorkerFinalization {
    completion_status: CompletionStatusV1,
    terminal_event: ResearchEventV1,
    events_prefix_byte_length: u64,
    finalized_at: String,
    lsl_marker_pushed: bool,
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
            monotonic_offset_ns: prepared.monotonic_offset_ns,
            recovery: prepared.recovery,
            resumed: prepared.resumed,
            finalization: None,
        }
    }

    fn start(&mut self) -> ResearchResult<()> {
        if self.resumed {
            let recovery_detail = if self.event_sequence == 0 {
                playback_provenance_detail(
                    self.receipt.playback_mode,
                    self.receipt.playback_qualification,
                )?
            } else {
                "durable-prefix-reconciled"
            };
            self.write_event(
                ResearchEventTypeV1::WriteRecovered,
                None,
                None,
                Some(recovery_detail.to_owned()),
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
            let playback_detail = playback_provenance_detail(
                self.receipt.playback_mode,
                self.receipt.playback_qualification,
            )?;
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

    fn apply_stimulus(&mut self, update: StimulusStateUpdate) -> ResearchResult<()> {
        authorize_run_id(&self.receipt.run_id, &update.run_id)?;
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
        if matches!(update.lifecycle, StimulusLifecycle::Completed)
            && identity.duration_ms - update.media_time_ms >= COMPLETION_EARLY_TOLERANCE_MS
        {
            return Err(CommandError::invalid_contract(
                "A completed stimulus must report media time within one second of its verified end.",
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
        self.write_event(event_type, Some(active), None, None)
            .map_err(|_| {
                CommandError::new(
                    RUN_EVIDENCE_PERSISTENCE_ERROR,
                    "The stimulus lifecycle transition could not be durably recorded.",
                )
            })?;
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

    fn apply_stimulus_message(
        &mut self,
        update: StimulusStateUpdate,
    ) -> (ResearchResult<()>, bool) {
        let result = self.apply_stimulus(update);
        let evidence_failure = result
            .as_ref()
            .is_err_and(|error| error.code == RUN_EVIDENCE_PERSISTENCE_ERROR);
        (result, evidence_failure)
    }

    fn reset_to_neutral(&mut self, now: Instant) {
        self.state.current_x = 0.0;
        self.state.current_y = 0.0;
        self.state.target_x = 0.0;
        self.state.target_y = 0.0;
        self.state.anchor = now;
        self.state.impulse_active_until = now;
        self.native_input_active = false;
        self.publish_authoritative_state(now);
    }

    fn current_input_active(&self, now: Instant) -> bool {
        self.native_input_active || now < self.state.impulse_active_until
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
        let event = self.next_event(event_type, stimulus, missed_slot_count, detail_code)?;
        self.files.write_event(&event)?;
        if let Some(lsl) = &self.lsl {
            let marker = event_marker(&event);
            lsl.push_marker(&marker)?;
        }
        self.publish_event_status(&event);
        self.checkpoint_journal(None, event.monotonic_time_ns)
    }

    fn next_event(
        &mut self,
        event_type: ResearchEventTypeV1,
        stimulus: Option<ActiveStimulus>,
        missed_slot_count: Option<u64>,
        detail_code: Option<String>,
    ) -> ResearchResult<ResearchEventV1> {
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
        Ok(ResearchEventV1 {
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
        })
    }

    fn publish_event_status(&self, event: &ResearchEventV1) {
        let mut status = lock(&self.status);
        status.event_count = event.sequence;
        if event.event_type == ResearchEventTypeV1::TimingGap {
            let missed = event.missed_slot_count.unwrap_or(0);
            status.gap_event_count = status.gap_event_count.saturating_add(1);
            status.missed_slot_count = status.missed_slot_count.saturating_add(missed);
        }
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

        if let Some(pending) = &self.finalization {
            if pending.completion_status != completion_status
                || pending.terminal_event.event_type != event
            {
                return Err(CommandError::invalid_contract(
                    "A finalization retry must keep the original terminal outcome.",
                ));
            }
        } else {
            let events_prefix_byte_length = self.files.synced_events_length()?;
            let terminal_event =
                self.next_event(event, self.active_stimulus.clone(), None, None)?;
            let finalized_at = terminal_event.wall_time_utc.clone();
            self.finalization = Some(WorkerFinalization {
                completion_status,
                terminal_event,
                events_prefix_byte_length,
                finalized_at,
                lsl_marker_pushed: false,
            });
        }
        self.clock = None;

        let pending = self
            .finalization
            .as_ref()
            .expect("finalization state was initialized")
            .clone();
        let mut final_status = lock(&self.status).clone();
        final_status.event_count = pending.terminal_event.sequence;
        self.files.prepare_finalization(
            &self.receipt,
            &self.settings,
            &self.assignment,
            &self.participant,
            &self.started_at,
            completion_status,
            &final_status,
            &self.recovery,
            &pending.terminal_event,
            pending.events_prefix_byte_length,
            &pending.finalized_at,
        )?;
        self.files
            .ensure_terminal_event(pending.events_prefix_byte_length, &pending.terminal_event)?;
        if !pending.lsl_marker_pushed {
            if let Some(lsl) = &self.lsl {
                lsl.push_marker(&event_marker(&pending.terminal_event))?;
            }
            if let Some(finalization) = &mut self.finalization {
                finalization.lsl_marker_pushed = true;
            }
        }
        self.publish_event_status(&pending.terminal_event);
        let receipt = self.files.complete_finalization(&self.receipt)?;
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
        authorize_run_id(&self.receipt.run_id, &report.run_id)?;
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
        self.clock = None;
        self.native_input_active = false;
        let mut status = lock(&self.status);
        status.active = false;
        status.phase = RunPhase::Failed;
        status.input_active = false;
        status.write_healthy = false;
        status.failure_code = Some(code.to_owned());
    }
}

fn authorize_webview_media_mode(playback_mode: Option<PlaybackMode>) -> ResearchResult<()> {
    match playback_mode {
        Some(PlaybackMode::UnqualifiedWebview) => Ok(()),
        Some(PlaybackMode::NativeLibvlc) => Err(CommandError::forbidden(
            "WebView media events cannot control a qualified native playback run.",
        )),
        None => Err(CommandError::no_active_run()),
    }
}

fn validate_run_id(run_id: &str) -> ResearchResult<()> {
    if Uuid::parse_str(run_id).is_err() {
        return Err(CommandError::invalid_contract(
            "The run ID must be a valid UUID issued by the native runtime.",
        ));
    }
    Ok(())
}

fn authorize_run_id(expected: &str, supplied: &str) -> ResearchResult<()> {
    validate_run_id(supplied)?;
    if supplied != expected {
        return Err(CommandError::forbidden(
            "The command does not belong to the active Research run.",
        ));
    }
    Ok(())
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

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunDirectoryIdentity {
    creation_time: u64,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunDirectoryIdentity {
    device: u64,
    inode: u64,
}

#[cfg(not(any(target_os = "windows", unix)))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunDirectoryIdentity {
    created: Option<std::time::SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CheckedRunDirectory {
    path: PathBuf,
    identity: RunDirectoryIdentity,
}

#[derive(Debug)]
struct RunOutputDirectories {
    workspace: CheckedRunDirectory,
    outputs: CheckedRunDirectory,
    experiment: CheckedRunDirectory,
    participant: CheckedRunDirectory,
}

impl RunOutputDirectories {
    fn prepare(
        workspace_root: &Path,
        experiment_id: &str,
        participant_id: &str,
    ) -> ResearchResult<Self> {
        if !is_safe_component(experiment_id) || !is_safe_component(participant_id) {
            return Err(CommandError::invalid_contract(
                "The run output identity contains an unsafe directory component.",
            ));
        }
        let workspace = checked_run_root(workspace_root)?;
        let outputs = checked_run_child(&workspace, "outputs")?;
        let experiment = ensure_checked_run_child(&outputs, experiment_id)?;
        let participant = ensure_checked_run_child(&experiment, participant_id)?;
        let directories = Self {
            workspace,
            outputs,
            experiment,
            participant,
        };
        directories.revalidate()?;
        Ok(directories)
    }

    fn revalidate(&self) -> ResearchResult<()> {
        require_same_run_directory(&self.workspace, checked_run_root(&self.workspace.path)?)?;
        require_same_run_directory(
            &self.outputs,
            checked_run_child(&self.workspace, "outputs")?,
        )?;
        let experiment_name = checked_run_directory_name(&self.experiment)?;
        require_same_run_directory(
            &self.experiment,
            checked_run_child(&self.outputs, experiment_name)?,
        )?;
        let participant_name = checked_run_directory_name(&self.participant)?;
        require_same_run_directory(
            &self.participant,
            checked_run_child(&self.experiment, participant_name)?,
        )
    }

    fn create_session(&self, session_stem: &str) -> ResearchResult<PathBuf> {
        if !is_safe_component(session_stem) {
            return Err(CommandError::invalid_contract(
                "The run session identity contains an unsafe directory component.",
            ));
        }
        self.revalidate()?;
        let session_path = self.participant.path.join(session_stem);
        fs::create_dir(&session_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CommandError::forbidden("The new run destination already exists.")
            } else {
                CommandError::io(error)
            }
        })?;
        let session = checked_run_child(&self.participant, session_stem)?;
        self.revalidate()?;
        require_same_run_directory(
            &session,
            checked_run_child(&self.participant, session_stem)?,
        )?;
        Ok(session.path)
    }
}

fn checked_run_root(path: &Path) -> ResearchResult<CheckedRunDirectory> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        CommandError::forbidden("The selected workspace output root is unavailable.")
    })?;
    require_ordinary_run_directory(&metadata)?;
    let canonical = path.canonicalize().map_err(|_| {
        CommandError::forbidden("The selected workspace output root is unavailable.")
    })?;
    Ok(CheckedRunDirectory {
        path: canonical,
        identity: run_directory_identity(&metadata),
    })
}

fn ensure_checked_run_child(
    parent: &CheckedRunDirectory,
    name: &str,
) -> ResearchResult<CheckedRunDirectory> {
    if !is_safe_component(name) {
        return Err(CommandError::invalid_contract(
            "The run output identity contains an unsafe directory component.",
        ));
    }
    let child = parent.path.join(name);
    match fs::symlink_metadata(&child) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&child).map_err(|create_error| {
                if create_error.kind() == std::io::ErrorKind::AlreadyExists {
                    CommandError::forbidden(
                        "A run output directory changed while it was being created.",
                    )
                } else {
                    CommandError::io(create_error)
                }
            })?;
        }
        Err(error) => return Err(CommandError::io(error)),
    }
    checked_run_child(parent, name)
}

fn checked_run_child(
    parent: &CheckedRunDirectory,
    name: &str,
) -> ResearchResult<CheckedRunDirectory> {
    let child = parent.path.join(name);
    let metadata = fs::symlink_metadata(&child)
        .map_err(|_| CommandError::forbidden("A required run output directory is unavailable."))?;
    require_ordinary_run_directory(&metadata)?;
    let canonical = child
        .canonicalize()
        .map_err(|_| CommandError::forbidden("A required run output directory is unavailable."))?;
    if canonical != child
        || canonical.parent() != Some(parent.path.as_path())
        || !canonical.starts_with(&parent.path)
    {
        return Err(CommandError::forbidden(
            "A run output directory is not the exact canonical child of its selected parent.",
        ));
    }
    Ok(CheckedRunDirectory {
        path: canonical,
        identity: run_directory_identity(&metadata),
    })
}

fn require_ordinary_run_directory(metadata: &fs::Metadata) -> ResearchResult<()> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CommandError::forbidden(
            "A run output path component is not an ordinary directory.",
        ));
    }
    Ok(())
}

fn checked_run_directory_name(directory: &CheckedRunDirectory) -> ResearchResult<&str> {
    directory
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::forbidden("A run output directory name is invalid."))
}

fn require_same_run_directory(
    expected: &CheckedRunDirectory,
    observed: CheckedRunDirectory,
) -> ResearchResult<()> {
    if observed != *expected {
        return Err(CommandError::forbidden(
            "A run output directory changed while the attempt was being prepared.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_directory_identity(metadata: &fs::Metadata) -> RunDirectoryIdentity {
    use std::os::windows::fs::MetadataExt;
    RunDirectoryIdentity {
        // Stable safe Rust exposes creation time rather than the Windows file
        // index. Canonical child checks remain the primary link/junction guard.
        creation_time: metadata.creation_time(),
    }
}

#[cfg(unix)]
fn run_directory_identity(metadata: &fs::Metadata) -> RunDirectoryIdentity {
    use std::os::unix::fs::MetadataExt;
    RunDirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
fn run_directory_identity(metadata: &fs::Metadata) -> RunDirectoryIdentity {
    RunDirectoryIdentity {
        created: metadata.created().ok(),
    }
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

fn playback_provenance_detail(
    mode: PlaybackMode,
    qualification: PlaybackQualification,
) -> ResearchResult<&'static str> {
    match (mode, qualification) {
        (PlaybackMode::NativeLibvlc, PlaybackQualification::QualifiedNative) => {
            Ok("playback-native-libvlc-qualified")
        }
        (PlaybackMode::UnqualifiedWebview, PlaybackQualification::Unqualified) => {
            Ok("playback-webview-unqualified")
        }
        _ => Err(CommandError::invalid_contract(
            "Playback mode and qualification provenance are inconsistent.",
        )),
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
    #[cfg(test)]
    fail_next_event_write: bool,
    #[cfg(test)]
    fail_next_journal_write: bool,
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
    #[serde(default = "unresumed_recovery_summary")]
    recovery: RecoverySummaryV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_finalization: Option<PendingFinalizationV1>,
}

fn unresumed_recovery_summary() -> RecoverySummaryV1 {
    RecoverySummaryV1 {
        resumed: false,
        source_run_id: None,
        restarted_stimulus_ids: Vec::new(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingFinalizationV1 {
    terminal_event: ResearchEventV1,
    events_prefix_byte_length: u64,
    manifest: ResearchRunManifestV2,
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
    valid_byte_length: u64,
    last_safe_position: u32,
    interrupted_stimulus_position: Option<u32>,
    last_monotonic_ns: u128,
    gap_event_count: u64,
    missed_slot_count: u64,
    durable_prefix_event: Option<ResearchEventV1>,
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
            recovery: unresumed_recovery_summary(),
            pending_finalization: None,
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
            #[cfg(test)]
            fail_next_event_write: false,
            #[cfg(test)]
            fail_next_journal_write: false,
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
            verify_committed_manifest(session_dir, &journal)?;
            remove_recovery_journal_if_present(&recovery_path);
            return Err(CommandError::forbidden(
                "The attempt is already durably finalized; stale recovery evidence was cleaned.",
            ));
        }
        if let Some(pending) = &journal.pending_finalization {
            validate_manifest_against_journal(&pending.manifest, &journal)?;
            commit_pending_finalization(session_dir, &journal)?;
            verify_committed_manifest(session_dir, &journal)?;
            remove_recovery_journal_if_present(&recovery_path);
            return Err(CommandError::forbidden(
                "The pending terminal attempt was durably finalized during recovery.",
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
        if (common_count as u64) < journal.partial_sample_count
            || recovered_events.event_count < journal.partial_event_count
            || recovered_events.last_safe_position < journal.last_safe_stimulus_position
            || recovered_events.gap_event_count < journal.gap_event_count
            || recovered_events.missed_slot_count < journal.missed_slot_count
        {
            return Err(CommandError::forbidden(
                "Recovery evidence is shorter than its last durable journal prefix.",
            ));
        }
        truncate_file_to_length(&events_path, recovered_events.valid_byte_length)?;
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
            #[cfg(test)]
            fail_next_event_write: false,
            #[cfg(test)]
            fail_next_journal_write: false,
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
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_event_write) {
            return Err(CommandError::io("injected event-write failure"));
        }
        let bytes = canonical_json(event, &[])?;
        self.events.write_all(&bytes).map_err(CommandError::io)?;
        self.events.write_all(b"\n").map_err(CommandError::io)?;
        self.events.flush().map_err(CommandError::io)
    }

    fn synced_events_length(&mut self) -> ResearchResult<u64> {
        self.events.flush().map_err(CommandError::io)?;
        self.events
            .get_ref()
            .sync_data()
            .map_err(CommandError::io)?;
        fs::metadata(&self.events_path)
            .map(|metadata| metadata.len())
            .map_err(CommandError::io)
    }

    fn ensure_terminal_event(
        &mut self,
        prefix_byte_length: u64,
        event: &ResearchEventV1,
    ) -> ResearchResult<()> {
        self.events.flush().map_err(CommandError::io)?;
        ensure_exact_append(
            &self.events_path,
            prefix_byte_length,
            &canonical_event_line(event)?,
        )
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
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_journal_write) {
            return Err(CommandError::io("injected journal-write failure"));
        }
        self.journal.partial_sample_count = sample_count;
        self.journal.partial_event_count = event_count;
        self.journal.last_safe_stimulus_position = last_safe_position;
        self.journal.interrupted_stimulus_position = interrupted_stimulus_position;
        self.journal.last_monotonic_time_ns = last_monotonic_time_ns;
        self.journal.gap_event_count = gap_event_count;
        self.journal.missed_slot_count = missed_slot_count;
        write_journal_record(&self.recovery_path, &self.journal, false)
    }

    fn update_recovery_summary(&mut self, recovery: RecoverySummaryV1) -> ResearchResult<()> {
        if !recovery_summary_append_is_valid(
            &self.journal.recovery,
            &recovery,
            &self.journal.run_id,
        ) {
            return Err(CommandError::invalid_contract(
                "Recovery provenance cannot replace or reorder durable history.",
            ));
        }
        self.journal.recovery = recovery;
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
    fn prepare_finalization(
        &mut self,
        receipt: &StartRunReceipt,
        settings: &ResearchSettingsV1,
        assignment: &ParticipantAssignmentV1,
        participant: &CodedParticipant,
        started_at: &str,
        completion_status: CompletionStatusV1,
        status: &RunStatus,
        recovery: &RecoverySummaryV1,
        terminal_event: &ResearchEventV1,
        events_prefix_byte_length: u64,
        finalized_at: &str,
    ) -> ResearchResult<()> {
        if *recovery != self.journal.recovery {
            return Err(CommandError::forbidden(
                "The finalization recovery provenance changed after its durable checkpoint.",
            ));
        }
        self.flush_tables()?;
        self.events.flush().map_err(CommandError::io)?;
        self.events.get_ref().sync_all().map_err(CommandError::io)?;
        if let Some(csv) = &self.csv {
            csv.get_ref().sync_all().map_err(CommandError::io)?;
        }
        if let Some(tsv) = &self.tsv {
            tsv.get_ref().sync_all().map_err(CommandError::io)?;
        }

        if let Some(pending) = &self.journal.pending_finalization {
            if pending.terminal_event != *terminal_event
                || pending.events_prefix_byte_length != events_prefix_byte_length
                || pending.manifest.completion_status != completion_status
            {
                return Err(CommandError::forbidden(
                    "The durable finalization intent does not match this retry.",
                ));
            }
            validate_manifest_against_journal(&pending.manifest, &self.journal)?;
            if self.recovery_path.exists() {
                write_journal_record(&self.recovery_path, &self.journal, false)?;
            } else if self.session_dir.join("manifest.json").exists() {
                verify_committed_manifest(&self.session_dir, &self.journal)?;
            } else {
                return Err(CommandError::forbidden(
                    "The durable finalization intent disappeared before commit.",
                ));
            }
            return Ok(());
        }
        let terminal_line = canonical_event_line(terminal_event)?;
        let mut outputs = vec![
            output_record(RunOutputKindV1::Settings, &self.settings_path, None)?,
            output_record_with_append(
                RunOutputKindV1::Events,
                &self.events_path,
                events_prefix_byte_length,
                &terminal_line,
                None,
            )?,
        ];
        if let (Some(partial), Some(final_path)) = (&self.csv_partial_path, &self.csv_path) {
            outputs.push(output_record_for_promotion(
                RunOutputKindV1::Csv,
                partial,
                final_path,
                Some(status.sample_count),
            )?);
        }
        if let (Some(partial), Some(final_path)) = (&self.tsv_partial_path, &self.tsv_path) {
            outputs.push(output_record_for_promotion(
                RunOutputKindV1::Tsv,
                partial,
                final_path,
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
            playback_mode: manifest_playback_mode(receipt.playback_mode),
            playback_qualification: manifest_playback_qualification(receipt.playback_qualification),
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
                finalized_at: finalized_at.to_owned(),
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
        self.journal.partial_sample_count = status.sample_count;
        self.journal.partial_event_count = status.event_count;
        self.journal.last_monotonic_time_ns = terminal_event.monotonic_time_ns.clone();
        self.journal.gap_event_count = status.gap_event_count;
        self.journal.missed_slot_count = status.missed_slot_count;
        self.journal.interrupted_stimulus_position = terminal_event.stimulus_position;
        self.journal.pending_finalization = Some(PendingFinalizationV1 {
            terminal_event: terminal_event.clone(),
            events_prefix_byte_length,
            manifest,
        });
        let pending = self
            .journal
            .pending_finalization
            .as_ref()
            .expect("pending finalization was initialized");
        validate_manifest_against_journal(&pending.manifest, &self.journal)?;
        write_journal_record(&self.recovery_path, &self.journal, false)
    }

    fn complete_finalization(
        &mut self,
        receipt: &StartRunReceipt,
    ) -> ResearchResult<FinalizeReceipt> {
        let pending = self
            .journal
            .pending_finalization
            .as_ref()
            .ok_or_else(|| CommandError::io("No durable finalization intent is available."))?;
        validate_manifest_against_journal(&pending.manifest, &self.journal)?;
        commit_pending_finalization(&self.session_dir, &self.journal)?;
        let manifest = &pending.manifest;
        validate_manifest_against_journal(manifest, &self.journal)?;
        let final_receipt = finalize_receipt_from_manifest(
            &self.session_dir,
            manifest,
            receipt.output_receipt_id.clone(),
        )?;
        remove_recovery_journal_if_present(&self.recovery_path);
        Ok(final_receipt)
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

fn canonical_event_line(event: &ResearchEventV1) -> ResearchResult<Vec<u8>> {
    let mut line = canonical_json(event, &[])?;
    line.push(b'\n');
    Ok(line)
}

fn ensure_exact_append(
    path: &Path,
    prefix_byte_length: u64,
    expected: &[u8],
) -> ResearchResult<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    let observed_length = file.metadata().map_err(CommandError::io)?.len();
    let expected_end = prefix_byte_length.saturating_add(expected.len() as u64);
    if observed_length < prefix_byte_length || observed_length > expected_end {
        return Err(CommandError::forbidden(
            "The terminal event destination changed during finalization.",
        ));
    }
    file.seek(SeekFrom::Start(prefix_byte_length))
        .map_err(CommandError::io)?;
    let mut observed = Vec::with_capacity((observed_length - prefix_byte_length) as usize);
    file.read_to_end(&mut observed).map_err(CommandError::io)?;
    if observed == expected {
        return Ok(());
    }
    if !expected.starts_with(&observed) {
        return Err(CommandError::forbidden(
            "The terminal event destination contains conflicting evidence.",
        ));
    }
    file.set_len(prefix_byte_length).map_err(CommandError::io)?;
    file.seek(SeekFrom::Start(prefix_byte_length))
        .map_err(CommandError::io)?;
    file.write_all(expected).map_err(CommandError::io)?;
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
                || candidate.experiment_id != previous.experiment_id
                || candidate.participant_id != previous.participant_id
                || candidate.participant_code != previous.participant_code
                || candidate.age != previous.age
                || candidate.gender != previous.gender
                || candidate.handedness != previous.handedness
                || candidate.attempt_number != previous.attempt_number
                || candidate.session_stem != previous.session_stem
                || candidate.settings_sha256 != previous.settings_sha256
                || candidate.assignment_plan_sha256 != previous.assignment_plan_sha256
                || candidate.playback_mode != previous.playback_mode
                || candidate.playback_qualification != previous.playback_qualification
                || candidate.started_at != previous.started_at
                || candidate.partial_sample_count < previous.partial_sample_count
                || candidate.partial_event_count < previous.partial_event_count
                || candidate.last_safe_stimulus_position < previous.last_safe_stimulus_position
                || candidate.gap_event_count < previous.gap_event_count
                || candidate.missed_slot_count < previous.missed_slot_count
                || !recovery_summary_append_is_valid(
                    &previous.recovery,
                    &candidate.recovery,
                    &candidate.run_id,
                )
                || previous.pending_finalization.is_some()
                    && candidate.pending_finalization != previous.pending_finalization
            {
                return Ok(None);
            }
        }
        latest = Some(candidate);
    }
    Ok(latest)
}

fn recovery_summary_append_is_valid(
    previous: &RecoverySummaryV1,
    candidate: &RecoverySummaryV1,
    run_id: &str,
) -> bool {
    if previous == candidate {
        return true;
    }
    if !candidate.resumed || candidate.source_run_id.as_deref() != Some(run_id) {
        return false;
    }
    if previous.resumed && previous.source_run_id != candidate.source_run_id {
        return false;
    }
    if !candidate
        .restarted_stimulus_ids
        .starts_with(&previous.restarted_stimulus_ids)
    {
        return false;
    }
    let added = candidate
        .restarted_stimulus_ids
        .len()
        .saturating_sub(previous.restarted_stimulus_ids.len());
    added <= 1
        && (!previous.resumed || previous.source_run_id.as_deref() == Some(run_id))
        && !(previous.resumed && candidate.restarted_stimulus_ids.is_empty())
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
    truncate_file_to_length(path, end)
}

fn truncate_file_to_length(path: &Path, length: u64) -> ResearchResult<()> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(CommandError::io)?;
    file.set_len(length).map_err(CommandError::io)?;
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
    let mut durable_prefix_event = None;
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
        if expected_sequence == journal.partial_event_count {
            durable_prefix_event = Some(event.clone());
        }
        event_count = expected_sequence;
        last_monotonic_ns = monotonic.unwrap_or_default();
        offset = offset.saturating_add(read as u64);
    }
    Ok(ReconciledEvents {
        event_count,
        valid_byte_length: offset,
        last_safe_position,
        interrupted_stimulus_position: active_position.or(interrupted_position),
        last_monotonic_ns,
        gap_event_count,
        missed_slot_count,
        durable_prefix_event,
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
    let recovery_id_is_canonical = Uuid::parse_str(&journal.recovery_id)
        .is_ok_and(|parsed| parsed.to_string() == journal.recovery_id);
    let run_id_is_canonical =
        Uuid::parse_str(&journal.run_id).is_ok_and(|parsed| parsed.to_string() == journal.run_id);
    let playback_contract_is_valid = matches!(
        (journal.playback_mode, journal.playback_qualification),
        (
            PlaybackMode::NativeLibvlc,
            PlaybackQualification::QualifiedNative
        ) | (
            PlaybackMode::UnqualifiedWebview,
            PlaybackQualification::Unqualified
        )
    );
    if journal.schema != "affect-research-recovery-journal"
        || journal.version != 1
        || !recovery_id_is_canonical
        || !run_id_is_canonical
        || journal.experiment_id != settings.experiment.id
        || journal.age == 0
        || journal.age > 120
        || journal.attempt_number == 0
        || journal.settings_sha256 != settings.canonical_sha256()?
        || journal.assignment_plan_sha256 != plan.plan_hash_sha256
        || journal.last_monotonic_time_ns.parse::<u128>().is_err()
        || OffsetDateTime::parse(&journal.started_at, &Rfc3339).is_err()
        || !is_safe_component(&journal.session_stem)
        || !playback_contract_is_valid
    {
        return Err(CommandError::invalid_contract(
            "The recovery journal does not match the supplied frozen run contracts.",
        ));
    }
    validate_journal_recovery_summary(journal, plan)?;
    if let Some(pending) = &journal.pending_finalization {
        validate_manifest_against_journal(&pending.manifest, journal)?;
    }
    Ok(())
}

fn validate_journal_recovery_summary(
    journal: &RecoveryJournalV1,
    plan: &ResolvedAssignmentPlanV1,
) -> ResearchResult<()> {
    if journal.recovery.resumed != journal.recovery.source_run_id.is_some()
        || journal
            .recovery
            .source_run_id
            .as_deref()
            .is_some_and(|source_run_id| source_run_id != journal.run_id)
        || (!journal.recovery.resumed && !journal.recovery.restarted_stimulus_ids.is_empty())
    {
        return Err(CommandError::invalid_contract(
            "The recovery journal contains inconsistent recovery provenance.",
        ));
    }
    let assignment = plan
        .assignment_for(&journal.participant_id)
        .ok_or_else(|| {
            CommandError::invalid_contract(
                "The recovery participant is absent from the frozen assignment plan.",
            )
        })?;
    let assigned_ids = assignment
        .slots
        .iter()
        .map(|slot| slot.stimulus_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut observed = std::collections::HashSet::new();
    if journal
        .recovery
        .restarted_stimulus_ids
        .iter()
        .any(|stimulus_id| {
            !assigned_ids.contains(stimulus_id.as_str()) || !observed.insert(stimulus_id.as_str())
        })
    {
        return Err(CommandError::invalid_contract(
            "The recovery journal contains invalid restarted-stimulus provenance.",
        ));
    }
    Ok(())
}

fn load_recovery_plan_snapshot(
    session_dir: &Path,
    journal: &RecoveryJournalV1,
) -> ResearchResult<ResolvedAssignmentPlanV1> {
    let bytes =
        fs::read(session_dir.join("assignment-plan.snapshot.json")).map_err(CommandError::io)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(CommandError::forbidden(
            "The frozen assignment-plan snapshot exceeds its recovery bound.",
        ));
    }
    let plan: ResolvedAssignmentPlanV1 = serde_json::from_slice(&bytes).map_err(|_| {
        CommandError::forbidden(
            "The frozen assignment-plan snapshot is not a strict Research plan.",
        )
    })?;
    if canonical_json(&plan, &[])? != bytes
        || plan.plan_hash_sha256 != journal.assignment_plan_sha256
        || plan.validate(&journal.settings_sha256).is_err()
    {
        return Err(CommandError::forbidden(
            "The frozen assignment-plan snapshot does not match the recovery identity.",
        ));
    }
    Ok(plan)
}

fn completed_boundary_is_durable(
    session_dir: &Path,
    journal: &RecoveryJournalV1,
    plan: &ResolvedAssignmentPlanV1,
) -> ResearchResult<bool> {
    let assignment = plan
        .assignment_for(&journal.participant_id)
        .ok_or_else(|| {
            CommandError::forbidden(
                "The recovery participant is absent from the frozen assignment plan.",
            )
        })?;
    let final_position = assignment.slots.len() as u32;
    if journal.last_safe_stimulus_position < final_position {
        return Ok(false);
    }
    if final_position == 0
        || journal.last_safe_stimulus_position != final_position
        || journal.interrupted_stimulus_position.is_some()
        || journal.partial_event_count == 0
    {
        return Err(CommandError::forbidden(
            "The recovery journal does not describe one exact completed assignment boundary.",
        ));
    }

    let reconciled = reconcile_events(&session_dir.join("events.jsonl"), journal)?;
    if reconciled.event_count < journal.partial_event_count {
        return Err(CommandError::forbidden(
            "The completed recovery event prefix is shorter than its durable journal receipt.",
        ));
    }
    let event = reconciled.durable_prefix_event.as_ref().ok_or_else(|| {
        CommandError::forbidden(
            "The completed recovery boundary has no exact durable event receipt.",
        )
    })?;
    let final_slot = assignment
        .slots
        .last()
        .ok_or_else(|| CommandError::forbidden("The frozen assignment has no final stimulus."))?;
    let expected_identity = plan
        .stimulus_by_id(&final_slot.stimulus_id)
        .ok_or_else(|| {
            CommandError::forbidden(
                "The frozen assignment final stimulus is absent from the resolved plan.",
            )
        })?
        .sample_identity();
    let media_time_ms = event.media_time_ms.unwrap_or(f64::NAN);
    if event.event_type != ResearchEventTypeV1::StimulusCompleted
        || event.sequence != journal.partial_event_count
        || event.stimulus_position != Some(final_position)
        || event.stimulus_identity.as_ref() != Some(&expected_identity)
        || !media_time_ms.is_finite()
        || media_time_ms < 0.0
        || media_time_ms > expected_identity.duration_ms
        || expected_identity.duration_ms - media_time_ms >= COMPLETION_EARLY_TOLERANCE_MS
        || event.monotonic_time_ns != journal.last_monotonic_time_ns
        || OffsetDateTime::parse(&event.wall_time_utc, &Rfc3339).is_err()
        || event.missed_slot_count.is_some()
        || event.detail_code.is_some()
    {
        return Err(CommandError::forbidden(
            "The durable final-stimulus event does not match the frozen completed assignment.",
        ));
    }
    Ok(true)
}

fn finalize_recovery_at_root(
    workspace_root: &Path,
    recovery_id: &str,
    settings: &ResearchSettingsV1,
    plan: &ResolvedAssignmentPlanV1,
) -> ResearchResult<FinalizeReceipt> {
    let (recovery_path, journal) = load_recovery_journal(workspace_root, recovery_id)?;
    validate_recovery_journal(&journal, settings, plan)?;
    let session_dir = recovery_session_dir(workspace_root, &journal)?;
    let participant_root = session_dir.parent().ok_or_else(|| {
        CommandError::forbidden("The recovery participant output is unavailable.")
    })?;
    let attempt_lock = acquire_attempt_lock(participant_root)?;
    verify_snapshot(
        &session_dir.join("settings.snapshot.json"),
        &canonical_json(settings, &[])?,
        "settings",
    )?;
    verify_snapshot(
        &session_dir.join("assignment-plan.snapshot.json"),
        &canonical_json(plan, &[])?,
        "assignment plan",
    )?;

    let manifest = if session_dir.join("manifest.json").exists() {
        verify_committed_manifest(&session_dir, &journal)?
    } else if journal.pending_finalization.is_some() {
        commit_pending_finalization(&session_dir, &journal)?;
        verify_committed_manifest(&session_dir, &journal)?
    } else {
        return finalize_completed_boundary_recovery(
            &session_dir,
            recovery_path,
            journal,
            settings,
            plan,
            attempt_lock,
        );
    };
    let receipt =
        finalize_receipt_from_manifest(&session_dir, &manifest, Uuid::new_v4().to_string())?;
    remove_recovery_journal_if_present(&recovery_path);
    Ok(receipt)
}

fn finalize_completed_boundary_recovery(
    session_dir: &Path,
    recovery_path: PathBuf,
    journal: RecoveryJournalV1,
    settings: &ResearchSettingsV1,
    plan: &ResolvedAssignmentPlanV1,
    attempt_lock: File,
) -> ResearchResult<FinalizeReceipt> {
    let assignment = plan
        .assignment_for(&journal.participant_id)
        .ok_or_else(|| {
            CommandError::forbidden(
                "The recovery participant is absent from the frozen assignment plan.",
            )
        })?
        .clone();
    let (mut files, _) =
        RunFiles::resume(session_dir, recovery_path, journal, settings, attempt_lock)?;
    if !completed_boundary_is_durable(session_dir, &files.journal, plan)? {
        return Err(CommandError::forbidden(
            "The recovery has no durable terminal finalization intent or completed boundary.",
        ));
    }

    let terminal_sequence = files
        .journal
        .partial_event_count
        .checked_add(1)
        .ok_or_else(|| CommandError::forbidden("The recovery event sequence is exhausted."))?;
    let terminal_monotonic_ns = files
        .journal
        .last_monotonic_time_ns
        .parse::<u128>()
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| CommandError::forbidden("The recovery monotonic sequence is exhausted."))?
        .to_string();
    let finalized_at = wall_time_now()?;
    let terminal_event = ResearchEventV1 {
        schema: RESEARCH_EVENT_SCHEMA.to_owned(),
        version: 1,
        sequence: terminal_sequence,
        run_id: files.journal.run_id.clone(),
        participant_id: files.journal.participant_id.clone(),
        attempt_number: files.journal.attempt_number,
        settings_sha256: files.journal.settings_sha256.clone(),
        assignment_plan_sha256: files.journal.assignment_plan_sha256.clone(),
        wall_time_utc: finalized_at.clone(),
        monotonic_time_ns: terminal_monotonic_ns,
        event_type: ResearchEventTypeV1::SessionCompleted,
        stimulus_identity: None,
        stimulus_position: None,
        media_time_ms: None,
        missed_slot_count: None,
        detail_code: None,
    };
    let participant = CodedParticipant {
        id: files.journal.participant_id.clone(),
        code: files.journal.participant_code.clone(),
        age: files.journal.age,
        gender: files.journal.gender,
        handedness: files.journal.handedness,
        attempt_number: files.journal.attempt_number,
    };
    let receipt = StartRunReceipt {
        run_id: files.journal.run_id.clone(),
        participant_id: files.journal.participant_id.clone(),
        attempt_number: files.journal.attempt_number,
        session_stem: files.journal.session_stem.clone(),
        settings_sha256: files.journal.settings_sha256.clone(),
        assignment_plan_sha256: files.journal.assignment_plan_sha256.clone(),
        output_receipt_id: Uuid::new_v4().to_string(),
        resumed: files.journal.recovery.resumed,
        resume_at_stimulus_position: None,
        playback_mode: files.journal.playback_mode,
        playback_qualification: files.journal.playback_qualification,
    };
    let mut status = RunStatus::idle();
    status.run_id = Some(receipt.run_id.clone());
    status.participant_id = Some(receipt.participant_id.clone());
    status.attempt_number = Some(receipt.attempt_number);
    status.phase = RunPhase::Finalizing;
    status.sample_count = files.journal.partial_sample_count;
    status.event_count = terminal_sequence;
    status.gap_event_count = files.journal.gap_event_count;
    status.missed_slot_count = files.journal.missed_slot_count;
    status.last_safe_stimulus_position = files.journal.last_safe_stimulus_position;
    status.playback_mode = Some(receipt.playback_mode);
    status.playback_qualification = Some(receipt.playback_qualification);
    let recovery = files.journal.recovery.clone();
    let started_at = files.journal.started_at.clone();
    let events_prefix_byte_length = files.synced_events_length()?;
    files.prepare_finalization(
        &receipt,
        settings,
        &assignment,
        &participant,
        &started_at,
        CompletionStatusV1::Completed,
        &status,
        &recovery,
        &terminal_event,
        events_prefix_byte_length,
        &finalized_at,
    )?;
    files.ensure_terminal_event(events_prefix_byte_length, &terminal_event)?;
    files.complete_finalization(&receipt)
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

fn output_record_with_append(
    kind: RunOutputKindV1,
    path: &Path,
    prefix_byte_length: u64,
    appended: &[u8],
    row_count: Option<u64>,
) -> ResearchResult<RunOutputV1> {
    if !regular_file_exists(path)? {
        return Err(CommandError::io(
            "An output required for finalization is unavailable.",
        ));
    }
    let mut file = File::open(path).map_err(CommandError::io)?;
    if file.metadata().map_err(CommandError::io)?.len() != prefix_byte_length {
        return Err(CommandError::forbidden(
            "The event log changed before its terminal intent became durable.",
        ));
    }
    let mut digest = Sha256::new();
    let mut observed_length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(CommandError::io)?;
        if count == 0 {
            break;
        }
        observed_length = observed_length.saturating_add(count as u64);
        digest.update(&buffer[..count]);
    }
    if observed_length != prefix_byte_length {
        return Err(CommandError::forbidden(
            "The event log changed while its terminal intent was being prepared.",
        ));
    }
    digest.update(appended);
    Ok(RunOutputV1 {
        kind,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| CommandError::io("An output file name is invalid."))?
            .to_owned(),
        sha256: format!("{:x}", digest.finalize()),
        byte_length: prefix_byte_length.saturating_add(appended.len() as u64),
        row_count,
    })
}

fn output_record_for_promotion(
    kind: RunOutputKindV1,
    partial_path: &Path,
    final_path: &Path,
    row_count: Option<u64>,
) -> ResearchResult<RunOutputV1> {
    let partial_exists = regular_file_exists(partial_path)?;
    let final_exists = regular_file_exists(final_path)?;
    let source = match (partial_exists, final_exists) {
        (true, false) => partial_path,
        (false, true) => final_path,
        (true, true) => return Err(CommandError::forbidden(
            "Both partial and final ratings files exist; finalization cannot choose between them.",
        )),
        (false, false) => {
            return Err(CommandError::io(
                "A ratings file required for finalization is unavailable.",
            ))
        }
    };
    let mut record = output_record(kind, source, row_count)?;
    record.file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::io("A final ratings file name is invalid."))?
        .to_owned();
    Ok(record)
}

fn regular_file_exists(path: &Path) -> ResearchResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(CommandError::forbidden(
            "A finalization path is not a regular file.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(CommandError::io(error)),
    }
}

fn expected_output_file_name(kind: RunOutputKindV1) -> &'static str {
    match kind {
        RunOutputKindV1::Settings => "settings.snapshot.json",
        RunOutputKindV1::Events => "events.jsonl",
        RunOutputKindV1::Csv => "ratings.csv",
        RunOutputKindV1::Tsv => "ratings.tsv",
    }
}

fn verify_output_record(path: &Path, expected: &RunOutputV1) -> ResearchResult<()> {
    if path.file_name().and_then(|name| name.to_str()) != Some(expected.file_name.as_str())
        || !regular_file_exists(path)?
    {
        return Err(CommandError::forbidden(
            "A finalized output does not match its frozen file identity.",
        ));
    }
    let (sha256, byte_length) = file_digest(path)?;
    if sha256 != expected.sha256 || byte_length != expected.byte_length {
        return Err(CommandError::forbidden(
            "A finalized output does not match its frozen digest and length.",
        ));
    }
    Ok(())
}

fn promote_or_verify_output(
    partial_path: &Path,
    final_path: &Path,
    expected: &RunOutputV1,
) -> ResearchResult<()> {
    let partial_exists = regular_file_exists(partial_path)?;
    let final_exists = regular_file_exists(final_path)?;
    match (partial_exists, final_exists) {
        (true, false) => {
            let mut staged = expected.clone();
            staged.file_name = partial_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| CommandError::io("A partial ratings file name is invalid."))?
                .to_owned();
            verify_output_record(partial_path, &staged)?;
            fs::rename(partial_path, final_path).map_err(CommandError::io)?;
            verify_output_record(final_path, expected)
        }
        (false, true) => verify_output_record(final_path, expected),
        (true, true) => Err(CommandError::forbidden(
            "Both partial and final ratings files exist during finalization.",
        )),
        (false, false) => Err(CommandError::io(
            "A ratings output disappeared during finalization.",
        )),
    }
}

fn manifest_playback_mode(mode: PlaybackMode) -> RunPlaybackModeV1 {
    match mode {
        PlaybackMode::NativeLibvlc => RunPlaybackModeV1::NativeLibvlc,
        PlaybackMode::UnqualifiedWebview => RunPlaybackModeV1::UnqualifiedWebview,
    }
}

fn manifest_playback_qualification(
    qualification: PlaybackQualification,
) -> RunPlaybackQualificationV1 {
    match qualification {
        PlaybackQualification::QualifiedNative => RunPlaybackQualificationV1::QualifiedNative,
        PlaybackQualification::Unqualified => RunPlaybackQualificationV1::Unqualified,
    }
}

fn validate_terminal_event(
    event: &ResearchEventV1,
    manifest: &ResearchRunManifestV2,
    journal: &RecoveryJournalV1,
) -> ResearchResult<()> {
    let expected_type = match manifest.completion_status {
        CompletionStatusV1::Completed => ResearchEventTypeV1::SessionCompleted,
        CompletionStatusV1::Partial => ResearchEventTypeV1::StoppedEarly,
    };
    let wall_time_is_valid = OffsetDateTime::parse(&event.wall_time_utc, &Rfc3339).is_ok();
    if event.schema != RESEARCH_EVENT_SCHEMA
        || event.version != 1
        || event.event_type != expected_type
        || event.sequence != manifest.timing.event_count
        || event.run_id != journal.run_id
        || event.participant_id != journal.participant_id
        || event.attempt_number != journal.attempt_number
        || event.settings_sha256 != journal.settings_sha256
        || event.assignment_plan_sha256 != journal.assignment_plan_sha256
        || event.monotonic_time_ns != journal.last_monotonic_time_ns
        || event.monotonic_time_ns.parse::<u128>().is_err()
        || !wall_time_is_valid
        || event.wall_time_utc != manifest.timing.finalized_at
        || event.missed_slot_count.is_some()
        || event.detail_code.is_some()
    {
        return Err(CommandError::forbidden(
            "The terminal event does not match the durable finalization manifest.",
        ));
    }

    let field_count = usize::from(event.stimulus_identity.is_some())
        + usize::from(event.stimulus_position.is_some())
        + usize::from(event.media_time_ms.is_some());
    if field_count != 0 && field_count != 3 {
        return Err(CommandError::forbidden(
            "The terminal event contains an incomplete stimulus identity.",
        ));
    }
    if manifest.completion_status == CompletionStatusV1::Completed {
        if field_count != 0
            || journal.last_safe_stimulus_position != manifest.stimuli.len() as u32
            || journal.interrupted_stimulus_position.is_some()
        {
            return Err(CommandError::forbidden(
                "A completed terminal event is not at the final safe boundary.",
            ));
        }
        return Ok(());
    }
    if field_count == 0 {
        if journal.interrupted_stimulus_position.is_some() {
            return Err(CommandError::forbidden(
                "The partial terminal event omits its durable interrupted stimulus identity.",
            ));
        }
        return Ok(());
    }

    let identity = event
        .stimulus_identity
        .as_ref()
        .expect("all terminal stimulus fields are present");
    identity.validate()?;
    let position = event
        .stimulus_position
        .expect("all terminal stimulus fields are present");
    let media_time_ms = event
        .media_time_ms
        .expect("all terminal stimulus fields are present");
    let expected_identity = position
        .checked_sub(1)
        .and_then(|index| manifest.stimuli.get(index as usize));
    if expected_identity != Some(identity)
        || position != journal.last_safe_stimulus_position.saturating_add(1)
        || Some(position) != journal.interrupted_stimulus_position
        || !media_time_ms.is_finite()
        || media_time_ms < 0.0
        || media_time_ms > identity.duration_ms
    {
        return Err(CommandError::forbidden(
            "The partial terminal event does not match its exact frozen stimulus boundary.",
        ));
    }
    Ok(())
}

fn validate_manifest_against_journal(
    manifest: &ResearchRunManifestV2,
    journal: &RecoveryJournalV1,
) -> ResearchResult<()> {
    manifest.validate()?;
    if manifest.run_id != journal.run_id
        || manifest.experiment_id != journal.experiment_id
        || manifest.participant_id != journal.participant_id
        || manifest.participant_code != journal.participant_code
        || manifest.age != journal.age
        || manifest.gender != journal.gender
        || manifest.handedness != journal.handedness
        || manifest.attempt_number != journal.attempt_number
        || manifest.session_stem != journal.session_stem
        || manifest.playback_mode != manifest_playback_mode(journal.playback_mode)
        || manifest.playback_qualification
            != manifest_playback_qualification(journal.playback_qualification)
        || manifest.settings_sha256 != journal.settings_sha256
        || manifest.assignment_plan_sha256 != journal.assignment_plan_sha256
        || manifest.timing.sample_count != journal.partial_sample_count
        || manifest.timing.event_count != journal.partial_event_count
        || manifest.timing.gap_event_count != journal.gap_event_count
        || manifest.timing.missed_slot_count != journal.missed_slot_count
        || manifest.timing.started_at != journal.started_at
        || manifest.recovery != journal.recovery
    {
        return Err(CommandError::forbidden(
            "The final manifest does not match the durable recovery identity.",
        ));
    }
    if let Some(pending) = &journal.pending_finalization {
        if pending.manifest != *manifest
            || validate_terminal_event(&pending.terminal_event, manifest, journal).is_err()
        {
            return Err(CommandError::forbidden(
                "The terminal event does not match the durable finalization manifest.",
            ));
        }
        let terminal_line_length = canonical_event_line(&pending.terminal_event)?.len() as u64;
        let events_output = manifest
            .outputs
            .iter()
            .find(|output| output.kind == RunOutputKindV1::Events);
        if events_output.is_none_or(|output| {
            output.byte_length
                != pending
                    .events_prefix_byte_length
                    .saturating_add(terminal_line_length)
        }) {
            return Err(CommandError::forbidden(
                "The terminal event length does not match the final event-log receipt.",
            ));
        }
    }
    for output in &manifest.outputs {
        if output.file_name != expected_output_file_name(output.kind) {
            return Err(CommandError::forbidden(
                "The final manifest contains an unexpected output file identity.",
            ));
        }
    }
    Ok(())
}

fn commit_pending_finalization(
    session_dir: &Path,
    journal: &RecoveryJournalV1,
) -> ResearchResult<()> {
    let pending = journal
        .pending_finalization
        .as_ref()
        .ok_or_else(|| CommandError::io("No durable finalization intent is available."))?;
    validate_manifest_against_journal(&pending.manifest, journal)?;
    ensure_exact_append(
        &session_dir.join("events.jsonl"),
        pending.events_prefix_byte_length,
        &canonical_event_line(&pending.terminal_event)?,
    )?;
    let manifest = &pending.manifest;
    for output in &manifest.outputs {
        let final_path = session_dir.join(expected_output_file_name(output.kind));
        match output.kind {
            RunOutputKindV1::Settings | RunOutputKindV1::Events => {
                verify_output_record(&final_path, output)?;
            }
            RunOutputKindV1::Csv | RunOutputKindV1::Tsv => {
                let partial_path = session_dir.join(format!("{}.partial", output.file_name));
                promote_or_verify_output(&partial_path, &final_path, output)?;
            }
        }
    }
    let manifest_path = session_dir.join("manifest.json");
    let expected = canonical_json(manifest, &[])?;
    if regular_file_exists(&manifest_path)? {
        let observed = fs::read(&manifest_path).map_err(CommandError::io)?;
        if observed != expected {
            return Err(CommandError::forbidden(
                "The durable manifest conflicts with the frozen finalization intent.",
            ));
        }
    } else if let Err(error) = write_new(&manifest_path, &expected) {
        if regular_file_exists(&manifest_path)? {
            let observed = fs::read(&manifest_path).map_err(CommandError::io)?;
            if observed != expected {
                return Err(CommandError::forbidden(
                    "A conflicting durable manifest won the finalization race.",
                ));
            }
        } else {
            return Err(error);
        }
    }
    verify_committed_manifest_outputs(session_dir, manifest)
}

fn verify_committed_manifest_outputs(
    session_dir: &Path,
    manifest: &ResearchRunManifestV2,
) -> ResearchResult<()> {
    for output in &manifest.outputs {
        verify_output_record(&session_dir.join(&output.file_name), output)?;
    }
    Ok(())
}

fn verify_committed_manifest(
    session_dir: &Path,
    journal: &RecoveryJournalV1,
) -> ResearchResult<ResearchRunManifestV2> {
    let path = session_dir.join("manifest.json");
    let bytes = fs::read(&path).map_err(CommandError::io)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(CommandError::forbidden(
            "The durable manifest exceeds the bounded recovery contract.",
        ));
    }
    let manifest: ResearchRunManifestV2 = serde_json::from_slice(&bytes).map_err(|_| {
        CommandError::forbidden("The durable manifest is not a strict ResearchRunManifestV2.")
    })?;
    if canonical_json(&manifest, &[])? != bytes {
        return Err(CommandError::forbidden(
            "The durable manifest is not canonically encoded.",
        ));
    }
    validate_manifest_against_journal(&manifest, journal)?;
    verify_committed_manifest_outputs(session_dir, &manifest)?;
    Ok(manifest)
}

fn remove_recovery_journal_if_present(path: &Path) {
    // A durable verified manifest is the scientific commit point. A stale
    // journal is retried as cleanup and must not relabel the run as failed.
    let _cleanup_result = fs::remove_file(path);
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

fn finalize_receipt_from_manifest(
    session_dir: &Path,
    manifest: &ResearchRunManifestV2,
    output_receipt_id: String,
) -> ResearchResult<FinalizeReceipt> {
    let mut files = manifest
        .outputs
        .iter()
        .map(|output| FinalizedFileReceipt {
            file_name: output.file_name.clone(),
            sha256: output.sha256.clone(),
            byte_length: output.byte_length,
        })
        .collect::<Vec<_>>();
    files.push(file_receipt(&session_dir.join("manifest.json"))?);
    Ok(FinalizeReceipt {
        run_id: manifest.run_id.clone(),
        participant_id: manifest.participant_id.clone(),
        attempt_number: manifest.attempt_number,
        completion_status: manifest.completion_status,
        output_receipt_id,
        files,
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
        let session_dir = match recovery_session_dir(workspace_root, &journal) {
            Ok(session_dir) => session_dir,
            Err(_) => {
                corrupt_recovery_ids
                    .push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
                continue;
            }
        };
        if session_dir.join("manifest.json").exists() {
            if verify_committed_manifest(&session_dir, &journal).is_ok() {
                remove_recovery_journal_if_present(&entry.path());
            } else {
                corrupt_recovery_ids
                    .push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
            }
            continue;
        }
        let pending_completion_status = match journal.pending_finalization.as_ref() {
            Some(pending) => {
                if validate_manifest_against_journal(&pending.manifest, &journal).is_err() {
                    corrupt_recovery_ids
                        .push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
                    continue;
                }
                Some(pending.manifest.completion_status)
            }
            None => {
                let completed =
                    load_recovery_plan_snapshot(&session_dir, &journal).and_then(|plan| {
                        validate_journal_recovery_summary(&journal, &plan)?;
                        completed_boundary_is_durable(&session_dir, &journal, &plan)
                    });
                match completed {
                    Ok(true) => Some(CompletionStatusV1::Completed),
                    Ok(false) => None,
                    Err(_) => {
                        corrupt_recovery_ids
                            .push(corrupt_recovery_id(&entry.file_name().to_string_lossy()));
                        continue;
                    }
                }
            }
        };
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
            finalization_pending: pending_completion_status.is_some(),
            pending_completion_status,
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
            "schema":INPUT_BINDING_SCHEMA,"version":1,"preset":"arrowKeys","kind":"digital",
            "stepSize":0.1,"directions":{
                "up":{"kind":"keyboard","code":"ArrowUp"},
                "down":{"kind":"keyboard","code":"ArrowDown"},
                "left":{"kind":"keyboard","code":"ArrowLeft"},
                "right":{"kind":"keyboard","code":"ArrowRight"}
            },"axes":null
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

    #[cfg(target_os = "windows")]
    fn create_directory_link(target: &Path, link: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn fresh_input_receipt(runtime: &ResearchRuntime, settings: &ResearchSettingsV1) -> String {
        runtime
            .input
            .issue_test_receipt_for_tests(settings.input.clone())
            .unwrap()
            .receipt_id
    }

    #[test]
    fn nested_output_files_are_rejected_without_recreation() {
        let base = temporary_directory("nested-output-file");
        let workspace = base.join("workspace");
        let outputs = workspace.join("outputs");
        fs::create_dir_all(&outputs).unwrap();
        let experiment = outputs.join("experiment");
        fs::write(&experiment, b"not a directory").unwrap();

        let experiment_error =
            RunOutputDirectories::prepare(&workspace, "experiment", "P001").unwrap_err();
        assert_eq!(experiment_error.code, "forbidden_operation");
        assert!(experiment.is_file());

        fs::remove_file(&experiment).unwrap();
        fs::create_dir(&experiment).unwrap();
        let participant = experiment.join("P001");
        fs::write(&participant, b"not a directory").unwrap();
        let participant_error =
            RunOutputDirectories::prepare(&workspace, "experiment", "P001").unwrap_err();
        assert_eq!(participant_error.code, "forbidden_operation");
        assert!(participant.is_file());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(any(target_os = "windows", unix))]
    #[test]
    fn nested_output_links_cannot_redirect_a_run_outside_the_workspace() {
        let base = temporary_directory("nested-output-link");
        let workspace = base.join("workspace");
        let outputs = workspace.join("outputs");
        let external = base.join("external");
        fs::create_dir_all(&outputs).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(external.join("must-remain.txt"), b"external").unwrap();
        let linked_experiment = outputs.join("experiment");
        create_directory_link(&external, &linked_experiment);

        let error = RunOutputDirectories::prepare(&workspace, "experiment", "P001").unwrap_err();
        assert_eq!(error.code, "forbidden_operation");
        assert!(!external.join("P001").exists());
        assert_eq!(
            fs::read(external.join("must-remain.txt")).unwrap(),
            b"external"
        );

        fs::remove_dir(&linked_experiment).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn same_path_nested_output_replacement_is_rejected_before_session_creation() {
        let base = temporary_directory("nested-output-replacement");
        let workspace = base.join("workspace");
        fs::create_dir_all(workspace.join("outputs")).unwrap();
        let directories = RunOutputDirectories::prepare(&workspace, "experiment", "P001").unwrap();
        let participant = directories.participant.path.clone();

        fs::remove_dir(&participant).unwrap();
        // Safe stable Rust exposes creation time rather than a Windows file ID.
        // Avoid timestamp-granularity ambiguity in this deterministic host test.
        std::thread::sleep(Duration::from_millis(20));
        fs::create_dir(&participant).unwrap();

        let error = directories.create_session("session-r01").unwrap_err();
        assert_eq!(error.code, "forbidden_operation");
        assert!(!participant.join("session-r01").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn preexisting_session_file_is_never_replaced() {
        let base = temporary_directory("nested-output-session-file");
        let workspace = base.join("workspace");
        fs::create_dir_all(workspace.join("outputs")).unwrap();
        let directories = RunOutputDirectories::prepare(&workspace, "experiment", "P001").unwrap();
        let session = directories.participant.path.join("session-r01");
        fs::write(&session, b"existing evidence").unwrap();

        let error = directories.create_session("session-r01").unwrap_err();
        assert_eq!(error.code, "forbidden_operation");
        assert_eq!(fs::read(&session).unwrap(), b"existing evidence");
        fs::remove_dir_all(base).unwrap();
    }

    struct PersistenceFixture {
        base: PathBuf,
        workspace_root: PathBuf,
        session_dir: PathBuf,
        settings: ResearchSettingsV1,
        plan: ResolvedAssignmentPlanV1,
        assignment: ParticipantAssignmentV1,
        participant: CodedParticipant,
        receipt: StartRunReceipt,
        status: RunStatus,
        recovery: RecoverySummaryV1,
        terminal_event: ResearchEventV1,
        events_prefix_byte_length: u64,
        finalized_at: String,
        files: RunFiles,
    }

    impl PersistenceFixture {
        fn new(label: &str) -> Self {
            let base = temporary_directory(label);
            let workspace_root = base.join("workspace");
            fs::create_dir_all(workspace_root.join("recovery")).unwrap();
            let workspace_file_id = Uuid::new_v4().to_string();
            let settings = test_settings(&"a".repeat(64), &workspace_file_id);
            let plan = test_plan(&settings);
            let assignment = plan.assignment_for("P001").unwrap().clone();
            let run_id = Uuid::new_v4().to_string();
            let session_stem = "P001_EM_A27_GW_HR_20260903T143012482Z_R01".to_owned();
            let participant_root = workspace_root
                .join("outputs")
                .join(&settings.experiment.id)
                .join("P001");
            fs::create_dir_all(&participant_root).unwrap();
            let session_dir = participant_root.join(&session_stem);
            fs::create_dir(&session_dir).unwrap();
            let participant = CodedParticipant {
                id: "P001".to_owned(),
                code: "EM".to_owned(),
                age: 27,
                gender: GenderCodeV1::W,
                handedness: HandednessCodeV1::R,
                attempt_number: 1,
            };
            let started_at = "2026-09-03T14:30:12.482Z";
            let receipt = StartRunReceipt {
                run_id: run_id.clone(),
                participant_id: participant.id.clone(),
                attempt_number: participant.attempt_number,
                session_stem: session_stem.clone(),
                settings_sha256: settings.canonical_sha256().unwrap(),
                assignment_plan_sha256: plan.plan_hash_sha256.clone(),
                output_receipt_id: Uuid::new_v4().to_string(),
                resumed: false,
                resume_at_stimulus_position: Some(1),
                playback_mode: PlaybackMode::UnqualifiedWebview,
                playback_qualification: PlaybackQualification::Unqualified,
            };
            let mut files = RunFiles::create(
                &workspace_root,
                &session_dir,
                &run_id,
                &settings,
                &plan,
                &participant,
                &session_stem,
                started_at,
                PlaybackMode::UnqualifiedWebview,
                PlaybackQualification::Unqualified,
                acquire_attempt_lock(&participant_root).unwrap(),
            )
            .unwrap();
            let events_prefix_byte_length = files.synced_events_length().unwrap();
            let terminal_event = ResearchEventV1 {
                schema: RESEARCH_EVENT_SCHEMA.to_owned(),
                version: 1,
                sequence: 1,
                run_id,
                participant_id: participant.id.clone(),
                attempt_number: participant.attempt_number,
                settings_sha256: receipt.settings_sha256.clone(),
                assignment_plan_sha256: receipt.assignment_plan_sha256.clone(),
                wall_time_utc: "2026-09-03T14:30:13.000Z".to_owned(),
                monotonic_time_ns: "1".to_owned(),
                event_type: ResearchEventTypeV1::StoppedEarly,
                stimulus_identity: None,
                stimulus_position: None,
                media_time_ms: None,
                missed_slot_count: None,
                detail_code: None,
            };
            let mut status = RunStatus::idle();
            status.active = true;
            status.run_id = Some(receipt.run_id.clone());
            status.participant_id = Some(participant.id.clone());
            status.attempt_number = Some(participant.attempt_number);
            status.phase = RunPhase::Finalizing;
            status.event_count = terminal_event.sequence;
            status.playback_mode = Some(PlaybackMode::UnqualifiedWebview);
            status.playback_qualification = Some(PlaybackQualification::Unqualified);
            Self {
                base,
                workspace_root,
                session_dir,
                settings,
                plan,
                assignment,
                participant,
                receipt,
                status,
                recovery: RecoverySummaryV1 {
                    resumed: false,
                    source_run_id: None,
                    restarted_stimulus_ids: Vec::new(),
                },
                terminal_event,
                events_prefix_byte_length,
                finalized_at: "2026-09-03T14:30:13.000Z".to_owned(),
                files,
            }
        }

        fn finalize(&mut self) -> ResearchResult<FinalizeReceipt> {
            self.files.prepare_finalization(
                &self.receipt,
                &self.settings,
                &self.assignment,
                &self.participant,
                "2026-09-03T14:30:12.482Z",
                CompletionStatusV1::Partial,
                &self.status,
                &self.recovery,
                &self.terminal_event,
                self.events_prefix_byte_length,
                &self.finalized_at,
            )?;
            self.files
                .ensure_terminal_event(self.events_prefix_byte_length, &self.terminal_event)?;
            self.files.complete_finalization(&self.receipt)
        }

        fn into_worker(self) -> (PathBuf, PathBuf, Arc<Mutex<RunStatus>>, RunWorker) {
            let Self {
                base,
                settings,
                plan,
                assignment,
                participant,
                receipt,
                files,
                ..
            } = self;
            let recovery_path = files.recovery_path.clone();
            let started_at = files.journal.started_at.clone();
            let prepared = PreparedRun {
                receipt,
                settings,
                plan,
                assignment,
                participant,
                started_at,
                run_epoch: Instant::now(),
                files,
                lsl: None,
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
            };
            let status = Arc::new(Mutex::new(prepared.initial_status()));
            let worker = RunWorker::new(prepared, Arc::clone(&status));
            (base, recovery_path, status, worker)
        }
    }

    #[test]
    fn participant_code_requires_two_uppercase_safe_graphemes() {
        assert_eq!(validate_participant_code("EM").unwrap(), "EM");
        assert_eq!(validate_participant_code("ËÅ").unwrap(), "ËÅ");
        assert!(validate_participant_code("Em").is_err());
        assert!(validate_participant_code("E_M").is_err());
    }

    #[test]
    fn zero_prefix_recovery_first_event_retains_playback_provenance() {
        assert_eq!(
            playback_provenance_detail(
                PlaybackMode::NativeLibvlc,
                PlaybackQualification::QualifiedNative,
            )
            .unwrap(),
            "playback-native-libvlc-qualified"
        );
        let fixture = PersistenceFixture::new("zero-prefix-playback-provenance");
        let session_dir = fixture.session_dir.clone();
        let (base, _, _, mut worker) = fixture.into_worker();
        worker.resumed = true;
        worker.recovery = RecoverySummaryV1 {
            resumed: true,
            source_run_id: Some(worker.receipt.run_id.clone()),
            restarted_stimulus_ids: Vec::new(),
        };
        worker.start().unwrap();
        drop(worker);

        let first_line = fs::read_to_string(session_dir.join("events.jsonl"))
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_owned();
        let first_event: ResearchEventV1 = serde_json::from_str(&first_line).unwrap();
        assert_eq!(first_event.event_type, ResearchEventTypeV1::WriteRecovered);
        assert_eq!(
            first_event.detail_code.as_deref(),
            Some("playback-webview-unqualified")
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn completed_stimulus_checkpoint_finalizes_after_reload_without_replay() {
        let fixture = PersistenceFixture::new("completed-boundary-finalize");
        let workspace_root = fixture.workspace_root.clone();
        let session_dir = fixture.session_dir.clone();
        let settings = fixture.settings.clone();
        let plan = fixture.plan.clone();
        let (base, recovery_path, _, mut worker) = fixture.into_worker();
        worker.start().unwrap();
        let run_id = worker.receipt.run_id.clone();
        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id: run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id: run_id.clone(),
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 1_000.0,
            })
            .unwrap();
        drop(worker);

        let journal = read_latest_journal(&recovery_path).unwrap().unwrap();
        assert_eq!(journal.last_safe_stimulus_position, 1);
        assert!(journal.interrupted_stimulus_position.is_none());
        assert!(journal.pending_finalization.is_none());
        let listing = scan_recoveries(&workspace_root).unwrap();
        assert_eq!(listing.recoveries.len(), 1);
        assert!(listing.recoveries[0].finalization_pending);
        assert_eq!(
            listing.recoveries[0].pending_completion_status,
            Some(CompletionStatusV1::Completed)
        );
        let replay_error = PreparedRun::resume(
            &workspace_root,
            &journal.recovery_id,
            settings.clone(),
            plan.clone(),
            PlaybackMode::UnqualifiedWebview,
            PlaybackQualification::Unqualified,
        )
        .err()
        .expect("a completed boundary must never resume acquisition");
        assert_eq!(replay_error.code, "forbidden_operation");

        let receipt =
            finalize_recovery_at_root(&workspace_root, &journal.recovery_id, &settings, &plan)
                .unwrap();
        assert_eq!(receipt.run_id, run_id);
        assert_eq!(receipt.completion_status, CompletionStatusV1::Completed);
        let events = fs::read_to_string(session_dir.join("events.jsonl")).unwrap();
        assert_eq!(events.matches("\"type\":\"stimulusCompleted\"").count(), 1);
        assert_eq!(events.matches("\"type\":\"sessionCompleted\"").count(), 1);
        assert_eq!(events.matches("\"type\":\"stimulusStarted\"").count(), 1);
        let manifest: ResearchRunManifestV2 =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.completion_status, CompletionStatusV1::Completed);
        assert_eq!(manifest.timing.event_count, journal.partial_event_count + 1);
        assert!(!recovery_path.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn completed_boundary_rejects_changed_final_stimulus_identity() {
        let fixture = PersistenceFixture::new("completed-boundary-identity");
        let workspace_root = fixture.workspace_root.clone();
        let session_dir = fixture.session_dir.clone();
        let settings = fixture.settings.clone();
        let plan = fixture.plan.clone();
        let (base, recovery_path, _, mut worker) = fixture.into_worker();
        worker.start().unwrap();
        let run_id = worker.receipt.run_id.clone();
        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id: run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id,
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 1_000.0,
            })
            .unwrap();
        drop(worker);

        let events_path = session_dir.join("events.jsonl");
        let mut lines = fs::read_to_string(&events_path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let final_line = lines.last_mut().unwrap();
        let mut event: ResearchEventV1 = serde_json::from_str(final_line).unwrap();
        event.stimulus_identity.as_mut().unwrap().stimulus_id = "video-substituted".to_owned();
        *final_line = String::from_utf8(canonical_event_line(&event).unwrap())
            .unwrap()
            .trim_end()
            .to_owned();
        fs::write(&events_path, format!("{}\n", lines.join("\n"))).unwrap();

        let journal = read_latest_journal(&recovery_path).unwrap().unwrap();
        let error =
            finalize_recovery_at_root(&workspace_root, &journal.recovery_id, &settings, &plan)
                .unwrap_err();
        assert_eq!(error.code, "forbidden_operation");
        assert!(!session_dir.join("manifest.json").exists());
        assert!(recovery_path.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finalization_retry_repairs_mixed_promotion_without_duplicate_terminal_event() {
        let mut fixture = PersistenceFixture::new("finalize-mixed-promotion");
        let first = fixture.finalize().unwrap();
        let first_manifest = fs::read(fixture.session_dir.join("manifest.json")).unwrap();

        fs::remove_file(fixture.session_dir.join("manifest.json")).unwrap();
        fs::rename(
            fixture.session_dir.join("ratings.tsv"),
            fixture.session_dir.join("ratings.tsv.partial"),
        )
        .unwrap();
        write_journal_record(&fixture.files.recovery_path, &fixture.files.journal, true).unwrap();

        let retried = fixture.finalize().unwrap();
        let retried_manifest = fs::read(fixture.session_dir.join("manifest.json")).unwrap();
        assert_eq!(retried, first);
        assert_eq!(retried_manifest, first_manifest);
        assert!(fixture.session_dir.join("ratings.csv").is_file());
        assert!(fixture.session_dir.join("ratings.tsv").is_file());
        assert!(!fixture.session_dir.join("ratings.csv.partial").exists());
        assert!(!fixture.session_dir.join("ratings.tsv.partial").exists());
        let events = fs::read_to_string(fixture.session_dir.join("events.jsonl")).unwrap();
        assert_eq!(events.matches("\"type\":\"stoppedEarly\"").count(), 1);
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn matching_manifest_with_stale_journal_is_cleanup_not_recovery() {
        let mut fixture = PersistenceFixture::new("finalize-stale-journal");
        fixture.finalize().unwrap();
        fixture.files.journal.pending_finalization = None;
        write_journal_record(&fixture.files.recovery_path, &fixture.files.journal, true).unwrap();
        let listing = scan_recoveries(&fixture.workspace_root).unwrap();
        assert!(listing.recoveries.is_empty());
        assert!(listing.corrupt_recovery_ids.is_empty());
        assert!(!fixture.files.recovery_path.exists());
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn idempotent_finalize_is_byte_identical_and_rejects_tampering() {
        let mut fixture = PersistenceFixture::new("finalize-idempotent");
        let first = fixture.finalize().unwrap();
        let first_manifest = fs::read(fixture.session_dir.join("manifest.json")).unwrap();
        let second = fixture.finalize().unwrap();
        assert_eq!(second, first);
        assert_eq!(
            fs::read(fixture.session_dir.join("manifest.json")).unwrap(),
            first_manifest
        );

        fs::write(fixture.session_dir.join("ratings.csv"), b"tampered").unwrap();
        let error = fixture.finalize().unwrap_err();
        assert_eq!(error.code, "forbidden_operation");
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reload_finalization_commits_without_media_input_or_sampling_preflight() {
        let mut fixture = PersistenceFixture::new("finalize-after-reload");
        let resumable = scan_recoveries(&fixture.workspace_root).unwrap();
        assert!(!resumable.recoveries[0].finalization_pending);
        assert_eq!(resumable.recoveries[0].pending_completion_status, None);
        let resumable_json = serde_json::to_value(&resumable.recoveries[0]).unwrap();
        assert_eq!(resumable_json["finalizationPending"], false);
        assert!(resumable_json["pendingCompletionStatus"].is_null());
        fixture
            .files
            .prepare_finalization(
                &fixture.receipt,
                &fixture.settings,
                &fixture.assignment,
                &fixture.participant,
                "2026-09-03T14:30:12.482Z",
                CompletionStatusV1::Partial,
                &fixture.status,
                &fixture.recovery,
                &fixture.terminal_event,
                fixture.events_prefix_byte_length,
                &fixture.finalized_at,
            )
            .unwrap();
        let pending = scan_recoveries(&fixture.workspace_root).unwrap();
        assert!(pending.recoveries[0].finalization_pending);
        assert_eq!(
            pending.recoveries[0].pending_completion_status,
            Some(CompletionStatusV1::Partial)
        );
        let pending_json = serde_json::to_value(&pending.recoveries[0]).unwrap();
        assert_eq!(pending_json["finalizationPending"], true);
        assert_eq!(pending_json["pendingCompletionStatus"], "partial");
        let recovery_id = fixture.files.journal.recovery_id.clone();
        let PersistenceFixture {
            base,
            workspace_root,
            session_dir,
            settings,
            plan,
            files,
            ..
        } = fixture;
        drop(files);

        let receipt =
            finalize_recovery_at_root(&workspace_root, &recovery_id, &settings, &plan).unwrap();
        assert_eq!(receipt.completion_status, CompletionStatusV1::Partial);
        assert!(session_dir.join("manifest.json").is_file());
        assert!(!workspace_root
            .join("recovery")
            .join(format!("{}.journal.json", receipt.run_id))
            .exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn inconsistent_pending_finalization_is_quarantined_from_recovery_listing() {
        let mut fixture = PersistenceFixture::new("pending-finalization-inconsistent");
        fixture
            .files
            .prepare_finalization(
                &fixture.receipt,
                &fixture.settings,
                &fixture.assignment,
                &fixture.participant,
                "2026-09-03T14:30:12.482Z",
                CompletionStatusV1::Partial,
                &fixture.status,
                &fixture.recovery,
                &fixture.terminal_event,
                fixture.events_prefix_byte_length,
                &fixture.finalized_at,
            )
            .unwrap();
        let mut inconsistent = fixture.files.journal.clone();
        inconsistent
            .pending_finalization
            .as_mut()
            .unwrap()
            .manifest
            .completion_status = CompletionStatusV1::Completed;
        let mut bytes = canonical_json(&inconsistent, &[]).unwrap();
        bytes.push(b'\n');
        fs::write(&fixture.files.recovery_path, bytes).unwrap();

        let listing = scan_recoveries(&fixture.workspace_root).unwrap();
        assert!(listing.recoveries.is_empty());
        assert_eq!(listing.corrupt_recovery_ids.len(), 1);
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finalization_rejects_playback_or_terminal_provenance_changes() {
        let mut fixture = PersistenceFixture::new("finalize-provenance");
        fixture
            .files
            .prepare_finalization(
                &fixture.receipt,
                &fixture.settings,
                &fixture.assignment,
                &fixture.participant,
                "2026-09-03T14:30:12.482Z",
                CompletionStatusV1::Partial,
                &fixture.status,
                &fixture.recovery,
                &fixture.terminal_event,
                fixture.events_prefix_byte_length,
                &fixture.finalized_at,
            )
            .unwrap();
        let mut changed_playback = fixture.files.journal.clone();
        changed_playback.playback_mode = PlaybackMode::NativeLibvlc;
        changed_playback.playback_qualification = PlaybackQualification::QualifiedNative;
        let manifest = &changed_playback
            .pending_finalization
            .as_ref()
            .unwrap()
            .manifest;
        assert_eq!(
            validate_manifest_against_journal(manifest, &changed_playback)
                .unwrap_err()
                .code,
            "forbidden_operation"
        );

        let mut changed_terminal = fixture.files.journal.clone();
        changed_terminal
            .pending_finalization
            .as_mut()
            .unwrap()
            .terminal_event
            .detail_code = Some("changed-terminal".to_owned());
        let manifest = &changed_terminal
            .pending_finalization
            .as_ref()
            .unwrap()
            .manifest;
        assert_eq!(
            validate_manifest_against_journal(manifest, &changed_terminal)
                .unwrap_err()
                .code,
            "forbidden_operation"
        );
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn lifecycle_evidence_failure_stops_worker_and_preserves_durable_recovery() {
        for fail_checkpoint in [false, true] {
            let fixture = PersistenceFixture::new(if fail_checkpoint {
                "lifecycle-checkpoint-failure"
            } else {
                "lifecycle-event-failure"
            });
            let run_id = fixture.receipt.run_id.clone();
            let (base, recovery_path, status, mut worker) = fixture.into_worker();
            worker.start().unwrap();
            if fail_checkpoint {
                worker.files.fail_next_journal_write = true;
            } else {
                worker.files.fail_next_event_write = true;
            }
            let (result, evidence_failure) = worker.apply_stimulus_message(StimulusStateUpdate {
                run_id,
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            });
            assert!(evidence_failure);
            assert_eq!(result.unwrap_err().code, RUN_EVIDENCE_PERSISTENCE_ERROR);
            worker.fail(RUN_EVIDENCE_PERSISTENCE_FAILURE);
            let failed = lock(&status).clone();
            assert!(!failed.active);
            assert_eq!(failed.phase, RunPhase::Failed);
            assert!(!failed.write_healthy);
            assert!(!failed.input_active);
            assert!(worker.clock.is_none());
            let journal = read_latest_journal(&recovery_path).unwrap().unwrap();
            assert_eq!(journal.partial_event_count, 2);
            drop(worker);
            fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn completed_lifecycle_cannot_advance_from_a_stale_near_start_timestamp() {
        let fixture = PersistenceFixture::new("completed-media-boundary");
        let run_id = fixture.receipt.run_id.clone();
        let (base, _recovery_path, status, mut worker) = fixture.into_worker();
        worker.start().unwrap();
        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id: run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        let stale = worker
            .apply_stimulus(StimulusStateUpdate {
                run_id: run_id.clone(),
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap_err();
        assert_eq!(stale.code, "invalid_research_contract");
        assert_eq!(worker.last_safe_position, 0);
        assert_eq!(lock(&status).phase, RunPhase::Playing);

        worker
            .apply_stimulus(StimulusStateUpdate {
                run_id,
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 1_000.0,
            })
            .unwrap();
        assert_eq!(worker.last_safe_position, 1);
        drop(worker);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recovery_refuses_to_truncate_below_its_durable_journal_prefix() {
        let mut fixture = PersistenceFixture::new("recovery-durable-prefix");
        fixture.files.journal.partial_sample_count = 1;
        fixture.files.journal.partial_event_count = 1;
        write_journal_record(&fixture.files.recovery_path, &fixture.files.journal, false).unwrap();
        fixture.files.sync_outputs().unwrap();
        let events_before = fs::read(fixture.session_dir.join("events.jsonl")).unwrap();
        let csv_before = fs::read(fixture.session_dir.join("ratings.csv.partial")).unwrap();
        let recovery_path = fixture.files.recovery_path.clone();
        let session_dir = fixture.session_dir.clone();
        let participant_root = session_dir.parent().unwrap().to_owned();
        let settings = fixture.settings.clone();
        drop(fixture.files);
        let journal = read_latest_journal(&recovery_path).unwrap().unwrap();
        let error = RunFiles::resume(
            &session_dir,
            recovery_path,
            journal,
            &settings,
            acquire_attempt_lock(&participant_root).unwrap(),
        )
        .err()
        .expect("a durable-prefix shortfall must fail recovery");
        assert_eq!(error.code, "forbidden_operation");
        assert_eq!(
            fs::read(session_dir.join("events.jsonl")).unwrap(),
            events_before
        );
        assert_eq!(
            fs::read(session_dir.join("ratings.csv.partial")).unwrap(),
            csv_before
        );
        fs::remove_dir_all(fixture.base).unwrap();
    }

    #[test]
    fn journal_append_cannot_change_frozen_playback_provenance() {
        let mut fixture = PersistenceFixture::new("journal-provenance");
        fixture.files.journal.playback_mode = PlaybackMode::NativeLibvlc;
        fixture.files.journal.playback_qualification = PlaybackQualification::QualifiedNative;
        write_journal_record(&fixture.files.recovery_path, &fixture.files.journal, false).unwrap();
        assert!(read_latest_journal(&fixture.files.recovery_path)
            .unwrap()
            .is_none());
        let base = fixture.base.clone();
        drop(fixture);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn webview_media_events_are_confined_to_the_unqualified_fallback() {
        assert!(authorize_webview_media_mode(Some(PlaybackMode::UnqualifiedWebview)).is_ok());
        let native = authorize_webview_media_mode(Some(PlaybackMode::NativeLibvlc)).unwrap_err();
        assert_eq!(native.code, "forbidden_operation");
        assert!(authorize_webview_media_mode(None).is_err());

        let active = "11111111-1111-4111-8111-111111111111";
        assert!(authorize_run_id(active, active).is_ok());
        let stale = authorize_run_id(active, "22222222-2222-4222-8222-222222222222").unwrap_err();
        assert_eq!(stale.code, "forbidden_operation");
        let malformed = authorize_run_id(active, "renderer-selected-run").unwrap_err();
        assert_eq!(malformed.code, "invalid_research_contract");
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
        let native_input_receipt_id = fresh_input_receipt(&runtime, &settings);
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
            input_test_receipt_id: native_input_receipt_id.clone(),
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
                input_test_receipt_id: native_input_receipt_id,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        assert_eq!(receipt.playback_mode, PlaybackMode::UnqualifiedWebview);
        assert_eq!(
            receipt.playback_qualification,
            PlaybackQualification::Unqualified
        );
        let startup_deadline = Instant::now() + Duration::from_secs(2);
        while runtime.status().phase == RunPhase::Prepared && Instant::now() < startup_deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(runtime.status().phase, RunPhase::BetweenStimuli);
        let stale_run_id = Uuid::new_v4().to_string();
        let stale_event = runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: stale_run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap_err();
        assert_eq!(stale_event.code, "forbidden_operation");
        let stale_finish = runtime
            .finish(&stale_run_id, FinishOutcome::StopEarly)
            .unwrap_err();
        assert_eq!(stale_finish.code, "forbidden_operation");
        assert_eq!(runtime.status().phase, RunPhase::BetweenStimuli);
        runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: receipt.run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        let sample_deadline = Instant::now() + Duration::from_secs(2);
        while runtime.status().sample_count < 2 && Instant::now() < sample_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            runtime.status().sample_count >= 2,
            "the authoritative scheduler did not publish two samples before the bounded deadline"
        );
        let finalized = runtime
            .finish(&receipt.run_id, FinishOutcome::StopEarly)
            .unwrap();
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
        assert_eq!(
            manifest.playback_mode,
            RunPlaybackModeV1::UnqualifiedWebview
        );
        assert_eq!(
            manifest.playback_qualification,
            RunPlaybackQualificationV1::Unqualified
        );
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

        let rerun_input_receipt_id = fresh_input_receipt(&runtime, &settings);
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
            input_test_receipt_id: rerun_input_receipt_id,
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
        let start_input_receipt_id = fresh_input_receipt(&runtime, &settings);
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
                input_test_receipt_id: start_input_receipt_id,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: started.run_id.clone(),
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
        let resume_input_receipt_id = fresh_input_receipt(&runtime, &settings);
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
                input_test_receipt_id: resume_input_receipt_id,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        assert_eq!(resumed.run_id, started.run_id);
        assert!(resumed.resumed);
        assert_eq!(resumed.resume_at_stimulus_position, Some(1));
        runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: resumed.run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: resumed.run_id.clone(),
                lifecycle: StimulusLifecycle::Completed,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 1_000.0,
            })
            .unwrap();
        runtime
            .finish(&resumed.run_id, FinishOutcome::Completed)
            .unwrap();

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
        let media_input_receipt_id = fresh_input_receipt(&runtime, &settings);
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
                input_test_receipt_id: media_input_receipt_id,
                playback_mode: PlaybackMode::UnqualifiedWebview,
            })
            .unwrap();
        runtime
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: started.run_id.clone(),
                lifecycle: StimulusLifecycle::Started,
                stimulus_id: "video-a".to_owned(),
                stimulus_position: 1,
                media_time_ms: 0.0,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(30));
        let failure = runtime
            .report_webview_media_failure(MediaPlaybackFailureReport {
                run_id: started.run_id.clone(),
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
            .set_webview_stimulus_state(StimulusStateUpdate {
                run_id: started.run_id.clone(),
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
