use crate::asset_vault::AssetVault;
use crate::error::CommandError;
use affect_tracker_study_core::{
    protocol_hash, resolve_study_order, AssetVerificationV1, CoreErrorCodeV1, CoreErrorV1,
    PlatformBuildIdentityV1, PlatformKindV1, ReducerOutcomeV1, ResultManifestV1,
    RunConfigurationV1, RunEventV1, RunPhaseV1, RunStateV1, Sha256HexV1, StudyActionV1,
    StudyAuthorityV1, StudyDefinitionV1, CONTRACT_VERSION_V1, RESULT_MANIFEST_SCHEMA_V1,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

const MAX_STUDY_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_RUN_CONFIGURATION_BYTES: usize = 128 * 1024;
const MAX_STUDY_ACTION_BYTES: usize = 512 * 1024;
const MAX_EVENT_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULT_MANIFEST_BYTES: usize = 1024 * 1024;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const LONG_FORM_CSV_HEADER: &[u8] = b"sequence,authority_generation,revision,run_id,section_id,trial_id,block_id,monotonic_ms,wall_time_utc,event_type,payload_json\r\n";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct PublishedStudyKey {
    study_id: String,
    revision: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyValidationV1 {
    pub study_id: String,
    pub revision: u32,
    pub protocol_hash: String,
    pub already_published: bool,
}

struct ActiveStudyRun {
    authority: StudyAuthorityV1,
    journal: RunEventJournal,
    asset_verification: Vec<AssetVerificationV1>,
}

#[derive(Default)]
struct StudyRuntimeInner {
    published_studies: BTreeMap<PublishedStudyKey, StudyDefinitionV1>,
    active_run: Option<ActiveStudyRun>,
    last_authority_generation: u64,
}

/// Process-local owner of the one desktop study authority.
///
/// The shared core owns all study transitions. This adapter serializes access,
/// keeps immutable published revisions, and commits returned events before it
/// makes a newly reduced state observable.
pub struct StudyRuntime {
    inner: Mutex<StudyRuntimeInner>,
    records_dir: PathBuf,
    asset_vault: Arc<AssetVault>,
}

impl StudyRuntime {
    #[must_use]
    pub fn new(records_dir: PathBuf, asset_vault: Arc<AssetVault>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(StudyRuntimeInner::default()),
            records_dir,
            asset_vault,
        })
    }

    pub fn validate_study_json(&self, study_json: &str) -> Result<StudyValidationV1, CommandError> {
        let study = parse_study_json(study_json)?;
        study.validate_draft().map_err(core_error)?;
        let calculated_hash = protocol_hash(&study).map_err(core_error)?;
        Ok(StudyValidationV1 {
            study_id: study.study_id,
            revision: study.revision,
            protocol_hash: calculated_hash.0,
            already_published: study.protocol_hash.is_some(),
        })
    }

    pub fn publish_study_json(&self, study_json: &str) -> Result<StudyDefinitionV1, CommandError> {
        let published = parse_study_json(study_json)?
            .published()
            .map_err(core_error)?;
        let key = PublishedStudyKey {
            study_id: published.study_id.clone(),
            revision: published.revision,
        };
        let mut inner = self.lock();
        if let Some(existing) = inner.published_studies.get(&key) {
            if existing == &published {
                return Ok(existing.clone());
            }
            return Err(CommandError::new(
                "published_revision_conflict",
                "That study revision is already published with different immutable content.",
            ));
        }
        inner.published_studies.insert(key, published.clone());
        Ok(published)
    }

    pub fn prepare_run(
        &self,
        study_id: &str,
        study_revision: u32,
        configuration: RunConfigurationV1,
        requested_authority_generation: Option<u64>,
    ) -> Result<RunStateV1, CommandError> {
        enforce_serialized_bound(
            &configuration,
            MAX_RUN_CONFIGURATION_BYTES,
            "run_configuration_too_large",
            "The run configuration exceeds the native authority limit.",
        )?;
        if configuration.platform.platform != PlatformKindV1::Desktop {
            return Err(CommandError::new(
                "invalid_native_platform",
                "The native desktop authority requires a desktop run configuration.",
            ));
        }
        let mut inner = self.lock();
        if inner
            .active_run
            .as_ref()
            .is_some_and(|run| !terminal_phase(run.authority.state().phase))
        {
            return Err(CommandError::new(
                "active_study_run",
                "Finish or abort the active study run before preparing another one.",
            ));
        }
        let authority_generation = requested_authority_generation.unwrap_or_else(|| {
            inner
                .last_authority_generation
                .checked_add(1)
                .unwrap_or(JAVASCRIPT_MAX_SAFE_INTEGER + 1)
        });
        if authority_generation == 0 || authority_generation > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(CommandError::new(
                "invalid_generation",
                "The authority generation must be a positive JSON-safe integer.",
            ));
        }
        if authority_generation <= inner.last_authority_generation {
            return Err(CommandError::new(
                "stale_generation",
                "The authority generation must increase for each prepared desktop run.",
            ));
        }
        let key = PublishedStudyKey {
            study_id: study_id.to_owned(),
            revision: study_revision,
        };
        let study = inner.published_studies.get(&key).cloned().ok_or_else(|| {
            CommandError::new(
                "study_not_published",
                "Publish this exact study revision before preparing a run.",
            )
        })?;
        let authority = StudyAuthorityV1::new(study, configuration, authority_generation)
            .map_err(core_error)?;
        // Verification observes the app-owned object bytes, not merely the
        // protocol descriptor or catalogue receipt. The returned path-free
        // evidence is immutable for this run and is never re-derived from a
        // later mutable asset alias during finalization.
        let asset_verification = self
            .asset_vault
            .verify_study_assets(&authority.study().media)?;
        let journal = RunEventJournal::create(&self.records_dir)?;
        let state = authority.state().clone();
        inner.last_authority_generation = authority_generation;
        inner.active_run = Some(ActiveStudyRun {
            authority,
            journal,
            asset_verification,
        });
        Ok(state)
    }

    pub fn state(&self) -> Result<RunStateV1, CommandError> {
        self.lock()
            .active_run
            .as_ref()
            .map(|run| run.authority.state().clone())
            .ok_or_else(|| CommandError::new("no_active_study_run", "No study run is active."))
    }

    pub fn apply(&self, action: StudyActionV1) -> Result<ReducerOutcomeV1, CommandError> {
        enforce_serialized_bound(
            &action,
            MAX_STUDY_ACTION_BYTES,
            "study_action_too_large",
            "The study action exceeds the native authority limit.",
        )?;
        let mut inner = self.lock();
        let active = inner
            .active_run
            .as_mut()
            .ok_or_else(|| CommandError::new("no_active_study_run", "No study run is active."))?;

        // Failed validation, reduction, or persistence must not advance the
        // desktop authority visible to local or future remote callers.
        let mut candidate = active.authority.clone();
        let outcome = candidate.apply(action).map_err(core_error)?;
        let append_checkpoint = active.journal.append(&outcome.events)?;
        if terminal_phase(outcome.state.phase) {
            let terminal_artifacts = (|| {
                let csv = active.journal.csv_artifact_metadata()?;
                let finalized_wall_time_utc = outcome
                    .events
                    .last()
                    .map(|event| event.wall_time_utc.as_str())
                    .ok_or_else(|| {
                        CommandError::new(
                            "study_manifest_missing_event",
                            "A terminal study transition must include a final event.",
                        )
                    })?;
                let manifest = create_result_manifest(
                    &candidate,
                    &active.asset_verification,
                    active.journal.result_id(),
                    csv.sha256.clone(),
                    finalized_wall_time_utc,
                )?;
                Ok::<_, CommandError>((manifest, csv))
            })();
            let (manifest, csv) = match terminal_artifacts {
                Ok(artifacts) => artifacts,
                Err(error) => {
                    active.journal.rollback_appended(append_checkpoint)?;
                    return Err(error);
                }
            };
            active
                .journal
                .finalize(append_checkpoint, &manifest, &csv)?;
        }
        active.authority = candidate;
        Ok(outcome)
    }

    #[cfg(test)]
    fn fail_next_finalize_for_test(&self) {
        let mut inner = self.lock();
        inner
            .active_run
            .as_mut()
            .expect("a run must be prepared before injecting finalization failure")
            .journal
            .injected_failure = Some(FinalizeFailurePoint::CsvRename);
    }

    #[cfg(test)]
    fn fail_next_manifest_finalize_for_test(&self) {
        let mut inner = self.lock();
        inner
            .active_run
            .as_mut()
            .expect("a run must be prepared before injecting manifest failure")
            .journal
            .injected_failure = Some(FinalizeFailurePoint::ManifestRename);
    }

    fn lock(&self) -> MutexGuard<'_, StudyRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn terminal_phase(phase: RunPhaseV1) -> bool {
    matches!(phase, RunPhaseV1::Completed | RunPhaseV1::Aborted)
}

fn create_result_manifest(
    authority: &StudyAuthorityV1,
    asset_verification: &[AssetVerificationV1],
    result_id: &str,
    csv_sha256: Sha256HexV1,
    finalized_wall_time_utc: &str,
) -> Result<ResultManifestV1, CommandError> {
    let study = authority.study();
    let configuration = authority.configuration();
    let state = authority.state();
    let completion_status = state.completion_status.ok_or_else(|| {
        CommandError::new(
            "study_manifest_missing_completion",
            "A terminal study state must declare its completion status.",
        )
    })?;
    let resolved_order = resolve_study_order(study, configuration).map_err(core_error)?;
    if !state.resolved_order.is_empty() && state.resolved_order != resolved_order {
        return Err(CommandError::new(
            "study_manifest_order_mismatch",
            "The terminal authority state does not match the shared resolved study order.",
        ));
    }
    let manifest = ResultManifestV1 {
        schema: RESULT_MANIFEST_SCHEMA_V1.to_owned(),
        version: CONTRACT_VERSION_V1,
        result_id: result_id.to_owned(),
        run_id: state.run_id.clone(),
        study_id: study.study_id.clone(),
        protocol_hash: state.protocol_hash.clone(),
        settings_sha256: study.pinned_settings.portable_settings_sha256.clone(),
        build: PlatformBuildIdentityV1 {
            platform: configuration.platform.platform,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            build_commit: env!("AFFECT_TRACKER_BUILD_COMMIT").to_owned(),
        },
        asset_verification: verified_asset_snapshot(study, asset_verification)?,
        random_seed: configuration.random_seed.clone(),
        counterbalance_group: configuration.counterbalance_group,
        resolved_order,
        completion_status,
        event_count: state.last_event_sequence,
        csv_sha256,
        finalized_wall_time_utc: finalized_wall_time_utc.to_owned(),
    };
    manifest.validate().map_err(core_error)?;
    Ok(manifest)
}

fn verified_asset_snapshot(
    study: &StudyDefinitionV1,
    snapshot: &[AssetVerificationV1],
) -> Result<Vec<AssetVerificationV1>, CommandError> {
    if snapshot.len() != study.media.len() {
        return Err(CommandError::new(
            "study_manifest_asset_snapshot",
            "The prepared asset verification snapshot is incomplete.",
        ));
    }
    for expected in &study.media {
        let Some(observed) = snapshot
            .iter()
            .find(|candidate| candidate.asset_id == expected.asset_id)
        else {
            return Err(CommandError::new(
                "study_manifest_asset_snapshot",
                "The prepared asset verification snapshot is incomplete.",
            ));
        };
        if !observed.verified
            || observed.expected_sha256 != expected.sha256
            || observed.expected_byte_length != expected.byte_length
            || observed.observed_sha256.as_ref() != Some(&expected.sha256)
            || observed.observed_byte_length != Some(expected.byte_length)
        {
            return Err(CommandError::new(
                "study_manifest_asset_snapshot",
                "The prepared asset verification snapshot does not match the published study.",
            ));
        }
    }
    Ok(snapshot.to_vec())
}

fn parse_study_json(study_json: &str) -> Result<StudyDefinitionV1, CommandError> {
    if study_json.is_empty() || study_json.len() > MAX_STUDY_JSON_BYTES {
        return Err(CommandError::new(
            "invalid_study_json",
            "Study JSON is empty or exceeds the native validation limit.",
        ));
    }
    serde_json::from_str(study_json).map_err(|_| {
        CommandError::new(
            "invalid_study_json",
            "Study JSON does not match the strict StudyDefinitionV1 contract.",
        )
    })
}

fn enforce_serialized_bound<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
    code: &'static str,
    message: &'static str,
) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        CommandError::new(
            "study_serialization",
            "The native study contract could not be encoded.",
        )
    })?;
    if bytes.len() > maximum_bytes {
        return Err(CommandError::new(code, message));
    }
    Ok(())
}

fn core_error(error: CoreErrorV1) -> CommandError {
    let code = match error.code {
        CoreErrorCodeV1::InvalidSchema => "study_invalid_schema",
        CoreErrorCodeV1::InvalidValue => "study_invalid_value",
        CoreErrorCodeV1::LimitExceeded => "study_limit_exceeded",
        CoreErrorCodeV1::DuplicateId => "study_duplicate_id",
        CoreErrorCodeV1::MissingReference => "study_missing_reference",
        CoreErrorCodeV1::HashMismatch => "study_hash_mismatch",
        CoreErrorCodeV1::CapabilityMissing => "study_capability_missing",
        CoreErrorCodeV1::StaleGeneration => "stale_generation",
        CoreErrorCodeV1::StaleRevision => "stale_revision",
        CoreErrorCodeV1::RunMismatch => "run_mismatch",
        CoreErrorCodeV1::PhasePreconditionFailed => "phase_precondition_failed",
        CoreErrorCodeV1::BlockPreconditionFailed => "block_precondition_failed",
        CoreErrorCodeV1::InvalidTransition => "invalid_study_transition",
        CoreErrorCodeV1::IncompleteQuestionnaire => "incomplete_questionnaire",
        CoreErrorCodeV1::TimeRegression => "study_time_regression",
        CoreErrorCodeV1::SerializationFailed => "study_serialization",
    };
    CommandError::new(code, format!("{}: {}", error.path, error.message))
}

struct CsvArtifactMetadata {
    sha256: Sha256HexV1,
    byte_length: u64,
    record_filename: String,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum FinalizeFailurePoint {
    ManifestRename,
    CsvRename,
}

struct RunEventJournal {
    file: Option<File>,
    result_id: String,
    partial_path: PathBuf,
    final_path: PathBuf,
    manifest_temp_path: PathBuf,
    manifest_final_path: PathBuf,
    finalized: bool,
    #[cfg(test)]
    injected_failure: Option<FinalizeFailurePoint>,
}

impl RunEventJournal {
    fn create(records_dir: &Path) -> Result<Self, CommandError> {
        fs::create_dir_all(records_dir).map_err(record_io_error)?;
        for _ in 0..8 {
            let record_id = Uuid::new_v4().simple().to_string();
            let result_id = format!("result-{record_id}");
            let partial_path = records_dir.join(format!("{record_id}.partial.csv"));
            let final_path = records_dir.join(format!("{record_id}.csv"));
            let manifest_temp_path = records_dir.join(format!("{record_id}.manifest.json.partial"));
            let manifest_final_path = records_dir.join(format!("{record_id}.manifest.json"));
            if final_path.exists() || manifest_temp_path.exists() || manifest_final_path.exists() {
                continue;
            }
            match OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&partial_path)
            {
                Ok(mut file) => {
                    if file
                        .write_all(LONG_FORM_CSV_HEADER)
                        .and_then(|()| file.flush())
                        .and_then(|()| file.sync_all())
                        .is_err()
                    {
                        drop(file);
                        let _ = fs::remove_file(&partial_path);
                        return Err(record_io_error(std::io::Error::other(
                            "could not initialize record",
                        )));
                    }
                    return Ok(Self {
                        file: Some(file),
                        result_id,
                        partial_path,
                        final_path,
                        manifest_temp_path,
                        manifest_final_path,
                        finalized: false,
                        #[cfg(test)]
                        injected_failure: None,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(record_io_error(error)),
            }
        }
        Err(CommandError::new(
            "study_record_collision",
            "The application could not allocate a unique study record.",
        ))
    }

    fn append(&mut self, events: &[RunEventV1]) -> Result<u64, CommandError> {
        let batch = encode_long_form_csv_batch(events)?;
        let file = self.file.as_mut().ok_or_else(|| {
            CommandError::new(
                "study_record_closed",
                "The active study record has already been finalized.",
            )
        })?;
        let start = file.stream_position().map_err(record_io_error)?;
        if batch.is_empty() {
            return Ok(start);
        }
        let result = file
            .write_all(&batch)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data());
        if result.is_err() {
            let _ = file.set_len(start);
            let _ = file.seek(SeekFrom::Start(start));
            let _ = file.sync_data();
            return Err(CommandError::new(
                "study_record_io",
                "The application could not durably append the study event batch.",
            ));
        }
        Ok(start)
    }

    fn result_id(&self) -> &str {
        &self.result_id
    }

    fn csv_artifact_metadata(&mut self) -> Result<CsvArtifactMetadata, CommandError> {
        let file = self.file.as_mut().ok_or_else(|| {
            CommandError::new(
                "study_record_closed",
                "The active study record has already been finalized.",
            )
        })?;
        file.flush()
            .and_then(|()| file.sync_all())
            .map_err(record_io_error)?;
        let byte_length = file.metadata().map_err(record_io_error)?.len();
        if byte_length < LONG_FORM_CSV_HEADER.len() as u64 {
            return Err(CommandError::new(
                "study_record_invalid",
                "The native study record is shorter than its required CSV header.",
            ));
        }

        let mut reader = File::open(&self.partial_path).map_err(record_io_error)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer).map_err(record_io_error)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let record_filename = self
            .final_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                CommandError::new(
                    "study_record_invalid",
                    "The application could not derive its opaque study-record filename.",
                )
            })?
            .to_owned();
        Ok(CsvArtifactMetadata {
            sha256: Sha256HexV1(format!("{:x}", hasher.finalize())),
            byte_length,
            record_filename,
        })
    }

    fn rollback_appended(&mut self, append_checkpoint: u64) -> Result<(), CommandError> {
        let file = self.file.as_mut().ok_or_else(record_recovery_error)?;
        rollback_file(file, append_checkpoint)
    }

    fn finalize(
        &mut self,
        append_checkpoint: u64,
        manifest: &ResultManifestV1,
        csv: &CsvArtifactMetadata,
    ) -> Result<(), CommandError> {
        if self.finalized {
            return Ok(());
        }
        let expected_filename = self
            .final_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                CommandError::new(
                    "study_record_invalid",
                    "The application could not verify its opaque study-record filename.",
                )
            })?;
        if csv.record_filename != expected_filename
            || csv.byte_length < LONG_FORM_CSV_HEADER.len() as u64
            || manifest.csv_sha256 != csv.sha256
        {
            self.rollback_appended(append_checkpoint)?;
            return Err(CommandError::new(
                "study_manifest_record_mismatch",
                "The result manifest does not describe the finalized CSV bytes.",
            ));
        }
        let mut manifest_bytes = match serde_json::to_vec_pretty(manifest) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.rollback_appended(append_checkpoint)?;
                return Err(CommandError::new(
                    "study_manifest_encode",
                    "The application could not encode the strict result manifest.",
                ));
            }
        };
        manifest_bytes.push(b'\n');
        if manifest_bytes.len() > MAX_RESULT_MANIFEST_BYTES {
            self.rollback_appended(append_checkpoint)?;
            return Err(CommandError::new(
                "study_manifest_too_large",
                "The result manifest exceeds the native persistence limit.",
            ));
        }
        if write_new_synced_file(&self.manifest_temp_path, &manifest_bytes).is_err() {
            let cleanup = remove_file_if_present(&self.manifest_temp_path);
            let rollback = self.rollback_appended(append_checkpoint);
            if cleanup.is_err() || rollback.is_err() {
                return Err(record_recovery_error());
            }
            return Err(manifest_finalize_error());
        }

        let mut file = self.file.take().ok_or_else(|| {
            CommandError::new(
                "study_record_closed",
                "The active study record has already been finalized.",
            )
        })?;
        if file.flush().and_then(|()| file.sync_all()).is_err() {
            let cleanup = remove_file_if_present(&self.manifest_temp_path);
            let rollback = rollback_file(&mut file, append_checkpoint);
            if cleanup.is_err() || rollback.is_err() {
                self.file = Some(file);
                return Err(record_recovery_error());
            }
            self.file = Some(file);
            return Err(record_finalize_error());
        }
        drop(file);

        #[cfg(test)]
        let injected_failure = self.injected_failure.take();
        #[cfg(not(test))]
        let injected_manifest_failure = false;
        #[cfg(test)]
        let injected_manifest_failure =
            matches!(injected_failure, Some(FinalizeFailurePoint::ManifestRename));

        let manifest_rename_result = if injected_manifest_failure {
            Err(std::io::Error::other(
                "injected manifest finalization failure",
            ))
        } else {
            fs::rename(&self.manifest_temp_path, &self.manifest_final_path)
        };
        if manifest_rename_result.is_err() {
            let cleanup = remove_file_if_present(&self.manifest_temp_path);
            let restore = self.reopen_and_rollback(append_checkpoint);
            if cleanup.is_err() || restore.is_err() {
                return Err(record_recovery_error());
            }
            return Err(manifest_finalize_error());
        }

        #[cfg(not(test))]
        let injected_csv_failure = false;
        #[cfg(test)]
        let injected_csv_failure =
            matches!(injected_failure, Some(FinalizeFailurePoint::CsvRename));
        let csv_rename_result = if injected_csv_failure {
            Err(std::io::Error::other("injected CSV finalization failure"))
        } else {
            fs::rename(&self.partial_path, &self.final_path)
        };
        if csv_rename_result.is_err() {
            let cleanup = remove_file_if_present(&self.manifest_final_path);
            let restore = self.reopen_and_rollback(append_checkpoint);
            if cleanup.is_err() || restore.is_err() {
                return Err(record_recovery_error());
            }
            return Err(record_finalize_error());
        }
        self.finalized = true;
        Ok(())
    }

    fn reopen_and_rollback(&mut self, append_checkpoint: u64) -> std::io::Result<()> {
        let mut reopened = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.partial_path)?;
        rollback_file_io(&mut reopened, append_checkpoint)?;
        self.file = Some(reopened);
        Ok(())
    }
}

fn write_new_synced_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn encode_long_form_csv_batch(events: &[RunEventV1]) -> Result<Vec<u8>, CommandError> {
    let mut batch = Vec::new();
    for event in events {
        let payload_json = serde_json::to_string(&event.payload).map_err(|_| {
            CommandError::new(
                "study_record_encode",
                "The application could not encode a study event payload.",
            )
        })?;
        let payload_value: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(|_| {
                CommandError::new(
                    "study_record_encode",
                    "The application could not identify a study event payload.",
                )
            })?;
        let event_type = payload_value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                CommandError::new(
                    "study_record_encode",
                    "The study event payload has no typed discriminator.",
                )
            })?;
        let cells = [
            event.sequence.to_string(),
            event.authority_generation.to_string(),
            event.revision.to_string(),
            event.run_id.clone(),
            event.section_id.clone().unwrap_or_default(),
            event.trial_id.clone().unwrap_or_default(),
            event.block_id.clone().unwrap_or_default(),
            event.monotonic_ms.to_string(),
            event.wall_time_utc.clone(),
            event_type.to_owned(),
            payload_json,
        ];
        push_csv_row(&mut batch, &cells);
        if batch.len() > MAX_EVENT_BATCH_BYTES {
            return Err(CommandError::new(
                "study_event_batch_too_large",
                "The accepted study event batch exceeds the journal limit.",
            ));
        }
    }
    Ok(batch)
}

fn push_csv_row(output: &mut Vec<u8>, cells: &[String]) {
    for (index, cell) in cells.iter().enumerate() {
        if index > 0 {
            output.push(b',');
        }
        push_csv_cell(output, cell);
    }
    output.extend_from_slice(b"\r\n");
}

fn push_csv_cell(output: &mut Vec<u8>, value: &str) {
    if value
        .bytes()
        .any(|byte| matches!(byte, b',' | b'"' | b'\r' | b'\n'))
    {
        output.push(b'"');
        for byte in value.bytes() {
            if byte == b'"' {
                output.push(b'"');
            }
            output.push(byte);
        }
        output.push(b'"');
    } else {
        output.extend_from_slice(value.as_bytes());
    }
}

fn rollback_file(file: &mut File, append_checkpoint: u64) -> Result<(), CommandError> {
    rollback_file_io(file, append_checkpoint).map_err(|_| record_recovery_error())
}

fn rollback_file_io(file: &mut File, append_checkpoint: u64) -> std::io::Result<()> {
    file.set_len(append_checkpoint)?;
    file.seek(SeekFrom::Start(append_checkpoint))?;
    file.flush()?;
    file.sync_data()
}

fn record_finalize_error() -> CommandError {
    CommandError::new(
        "study_record_finalize",
        "The application could not atomically finalize the study record; the recoverable partial record remains authoritative.",
    )
}

fn manifest_finalize_error() -> CommandError {
    CommandError::new(
        "study_manifest_finalize",
        "The application could not atomically finalize the strict result manifest; the recoverable partial CSV remains authoritative.",
    )
}

fn record_recovery_error() -> CommandError {
    CommandError::new(
        "study_record_recovery",
        "The application could not restore its partial study record after finalization failed.",
    )
}

fn record_io_error(_: std::io::Error) -> CommandError {
    CommandError::new(
        "study_record_io",
        "The application could not access its private study record storage.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_vault::ImportStudyAssetRequestV1;
    use affect_tracker_study_core::{
        ActionPreconditionV1, EventClockV1, StudyCommandV1, STUDY_ACTION_SCHEMA_V1,
    };

    const FIXTURE_MEDIA_BYTES: &[u8] = b"native unprobed media identity fixture";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "affect-tracker-study-runtime-{}",
                Uuid::new_v4().simple()
            ));
            Self(path)
        }

        fn records_dir(&self) -> PathBuf {
            self.0.join("records")
        }

        fn vault_root(&self) -> PathBuf {
            self.0.join("vault")
        }

        fn source_path(&self) -> PathBuf {
            self.0.join("source.mp4")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture_configuration() -> RunConfigurationV1 {
        serde_json::from_str(include_str!(
            "../../crates/study-core/fixtures/run-configuration-v1.json"
        ))
        .unwrap()
    }

    fn fixture_media_sha256() -> Sha256HexV1 {
        Sha256HexV1(format!("{:x}", Sha256::digest(FIXTURE_MEDIA_BYTES)))
    }

    fn fixture_study_json() -> String {
        fixture_study_json_with_asset(fixture_media_sha256(), FIXTURE_MEDIA_BYTES.len() as u64)
    }

    fn fixture_study_json_with_asset(sha256: Sha256HexV1, byte_length: u64) -> String {
        let mut study: serde_json::Value = serde_json::from_str(include_str!(
            "../../crates/study-core/fixtures/study-v1.json"
        ))
        .unwrap();
        study["media"][0]["sha256"] = serde_json::json!(sha256.0);
        study["media"][0]["byteLength"] = serde_json::json!(byte_length);
        serde_json::to_string(&study).unwrap()
    }

    fn import_fixture_asset(directory: &TestDirectory, vault: &AssetVault) {
        fs::create_dir_all(&directory.0).unwrap();
        let source_path = directory.source_path();
        fs::write(&source_path, FIXTURE_MEDIA_BYTES).unwrap();
        vault
            .import(ImportStudyAssetRequestV1 {
                source_path,
                asset_id: "clip-a".to_owned(),
                expected_sha256: fixture_media_sha256(),
                expected_byte_length: FIXTURE_MEDIA_BYTES.len() as u64,
                mime_type: "video/mp4".to_owned(),
                container: "mp4".to_owned(),
            })
            .unwrap();
    }

    fn fixture_runtime_with_vault(
        directory: &TestDirectory,
        import_asset: bool,
    ) -> (Arc<StudyRuntime>, Arc<AssetVault>) {
        runtime_with_study_and_vault(directory, import_asset, &fixture_study_json())
    }

    fn runtime_with_study_and_vault(
        directory: &TestDirectory,
        import_asset: bool,
        study_json: &str,
    ) -> (Arc<StudyRuntime>, Arc<AssetVault>) {
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        if import_asset {
            import_fixture_asset(directory, &vault);
        }
        let runtime = StudyRuntime::new(directory.records_dir(), Arc::clone(&vault));
        runtime.publish_study_json(study_json).unwrap();
        (runtime, vault)
    }

    fn fixture_runtime(directory: &TestDirectory) -> Arc<StudyRuntime> {
        fixture_runtime_with_vault(directory, true).0
    }

    fn action_for(
        state: &RunStateV1,
        action_id: &str,
        monotonic_ms: u64,
        command: StudyCommandV1,
    ) -> StudyActionV1 {
        StudyActionV1 {
            schema: STUDY_ACTION_SCHEMA_V1.to_owned(),
            version: CONTRACT_VERSION_V1,
            action_id: action_id.to_owned(),
            run_id: state.run_id.clone(),
            authority_generation: state.authority_generation,
            expected_revision: state.revision,
            precondition: ActionPreconditionV1 {
                expected_phase: state.phase,
                expected_block_id: state.current_block_id.clone(),
            },
            clock: EventClockV1 {
                monotonic_ms,
                wall_time_utc: format!("2026-09-03T12:00:{:02}Z", monotonic_ms % 60),
            },
            command,
        }
    }

    fn record_files(directory: &TestDirectory) -> Vec<PathBuf> {
        fs::read_dir(directory.records_dir())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
    }

    fn record_file_with_suffix(directory: &TestDirectory, suffix: &str) -> PathBuf {
        record_files(directory)
            .into_iter()
            .find(|path| path.to_string_lossy().ends_with(suffix))
            .unwrap_or_else(|| panic!("missing record artifact ending in {suffix}"))
    }

    fn parse_csv_records(value: &str) -> Vec<Vec<String>> {
        let mut records = Vec::new();
        let mut record = Vec::new();
        let mut cell = String::new();
        let mut quoted = false;
        let mut characters = value.chars().peekable();
        while let Some(character) = characters.next() {
            if quoted {
                if character == '"' {
                    if characters.peek() == Some(&'"') {
                        characters.next();
                        cell.push('"');
                    } else {
                        quoted = false;
                    }
                } else {
                    cell.push(character);
                }
                continue;
            }
            match character {
                '"' => quoted = true,
                ',' => record.push(std::mem::take(&mut cell)),
                '\r' => {
                    assert_eq!(characters.next(), Some('\n'));
                    record.push(std::mem::take(&mut cell));
                    records.push(std::mem::take(&mut record));
                }
                '\n' => panic!("CSV records must use CRLF line endings"),
                _ => cell.push(character),
            }
        }
        assert!(!quoted, "CSV must not end inside a quoted cell");
        assert!(record.is_empty() && cell.is_empty(), "CSV must end in CRLF");
        records
    }

    fn assert_csv_events(csv: &str, events: &[RunEventV1]) {
        let records = parse_csv_records(csv);
        assert_eq!(
            records[0],
            [
                "sequence",
                "authority_generation",
                "revision",
                "run_id",
                "section_id",
                "trial_id",
                "block_id",
                "monotonic_ms",
                "wall_time_utc",
                "event_type",
                "payload_json",
            ]
        );
        assert_eq!(records.len(), events.len() + 1);
        for (record, event) in records[1..].iter().zip(events) {
            assert_eq!(record.len(), 11);
            assert_eq!(record[0], event.sequence.to_string());
            assert_eq!(record[1], event.authority_generation.to_string());
            assert_eq!(record[2], event.revision.to_string());
            assert_eq!(record[3], event.run_id);
            assert_eq!(record[4], event.section_id.as_deref().unwrap_or(""));
            assert_eq!(record[5], event.trial_id.as_deref().unwrap_or(""));
            assert_eq!(record[6], event.block_id.as_deref().unwrap_or(""));
            assert_eq!(record[7], event.monotonic_ms.to_string());
            assert_eq!(record[8], event.wall_time_utc);
            let payload: serde_json::Value = serde_json::from_str(&record[10]).unwrap();
            assert_eq!(record[9], payload["type"].as_str().unwrap());
            assert_eq!(payload, serde_json::to_value(&event.payload).unwrap());
        }
    }

    #[test]
    fn publishing_is_idempotent_but_revisions_are_immutable() {
        let directory = TestDirectory::new();
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let runtime = StudyRuntime::new(directory.records_dir(), vault);
        let source = include_str!("../../crates/study-core/fixtures/study-v1.json");
        let validated = runtime.validate_study_json(source).unwrap();
        assert_eq!(validated.study_id, "parity-fixture");
        assert!(!validated.already_published);
        assert_eq!(validated.protocol_hash.len(), 64);

        let first = runtime.publish_study_json(source).unwrap();
        let second = runtime.publish_study_json(source).unwrap();
        assert_eq!(first, second);

        let mut changed: serde_json::Value = serde_json::from_str(source).unwrap();
        changed["title"] = serde_json::json!("Changed after publication");
        let error = runtime
            .publish_study_json(&serde_json::to_string(&changed).unwrap())
            .unwrap_err();
        assert_eq!(error.code, "published_revision_conflict");
    }

    #[test]
    fn csv_cells_use_rfc_quote_escaping() {
        let mut encoded = Vec::new();
        push_csv_cell(&mut encoded, "alpha,\"beta\"\r\ngamma");
        assert_eq!(
            String::from_utf8(encoded).unwrap(),
            "\"alpha,\"\"beta\"\"\r\ngamma\""
        );
    }

    #[test]
    fn accepted_actions_are_durable_before_state_advances() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        assert_eq!(created.phase, RunPhaseV1::Created);

        let prepare = action_for(&created, "prepare-native", 1, StudyCommandV1::Prepare);
        let outcome = runtime.apply(prepare.clone()).unwrap();
        assert_eq!(outcome.state.phase, RunPhaseV1::Prepared);
        assert_eq!(runtime.state().unwrap(), outcome.state);

        let files = record_files(&directory);
        assert_eq!(files.len(), 1);
        assert!(files[0].to_string_lossy().ends_with(".partial.csv"));
        let journal = fs::read_to_string(&files[0]).unwrap();
        assert!(journal.contains("\"{\"\"type\"\":\"\"prepared\"\"}\""));
        assert_csv_events(&journal, &outcome.events);

        let error = runtime.apply(prepare).unwrap_err();
        assert_eq!(error.code, "stale_revision");
        assert_eq!(fs::read_to_string(&files[0]).unwrap(), journal);
    }

    #[test]
    fn matching_vault_asset_prepares_with_a_fresh_verification_snapshot() {
        let directory = TestDirectory::new();
        let (runtime, _) = fixture_runtime_with_vault(&directory, true);
        runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();

        let inner = runtime.lock();
        let snapshot = &inner.active_run.as_ref().unwrap().asset_verification;
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].verified);
        assert_eq!(snapshot[0].asset_id, "clip-a");
        assert_eq!(snapshot[0].expected_sha256, fixture_media_sha256());
        assert_eq!(snapshot[0].observed_sha256, Some(fixture_media_sha256()));
        assert_eq!(
            snapshot[0].observed_byte_length,
            Some(FIXTURE_MEDIA_BYTES.len() as u64)
        );
    }

    #[test]
    fn missing_vault_asset_fails_before_run_or_record_creation() {
        let directory = TestDirectory::new();
        let (runtime, vault) = fixture_runtime_with_vault(&directory, false);
        let error = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(error.code, "study_asset_missing");
        assert_eq!(runtime.state().unwrap_err().code, "no_active_study_run");
        assert!(!directory.records_dir().exists());

        import_fixture_asset(&directory, &vault);
        let prepared = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        assert_eq!(prepared.authority_generation, 7);
    }

    #[test]
    fn catalogue_digest_and_length_mismatches_fail_preflight() {
        let digest_directory = TestDirectory::new();
        let digest_study = fixture_study_json_with_asset(
            Sha256HexV1("c".repeat(64)),
            FIXTURE_MEDIA_BYTES.len() as u64,
        );
        let (digest_runtime, _) =
            runtime_with_study_and_vault(&digest_directory, true, &digest_study);
        let error = digest_runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(error.code, "study_asset_digest_mismatch");
        assert!(!digest_directory.records_dir().exists());

        let length_directory = TestDirectory::new();
        let length_study = fixture_study_json_with_asset(
            fixture_media_sha256(),
            FIXTURE_MEDIA_BYTES.len() as u64 + 1,
        );
        let (length_runtime, _) =
            runtime_with_study_and_vault(&length_directory, true, &length_study);
        let error = length_runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(error.code, "study_asset_length_mismatch");
        assert!(!length_directory.records_dir().exists());
    }

    #[test]
    fn freshly_observed_object_drift_fails_preflight() {
        let directory = TestDirectory::new();
        let (runtime, _) = fixture_runtime_with_vault(&directory, true);
        let sha256 = fixture_media_sha256();
        let object_path = directory
            .vault_root()
            .join("objects")
            .join(&sha256.0[..2])
            .join(format!("{}.blob", sha256.0));
        let mut tampered = FIXTURE_MEDIA_BYTES.to_vec();
        tampered[0] ^= 1;
        fs::write(&object_path, tampered).unwrap();

        let error = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(error.code, "study_asset_digest_mismatch");
        assert!(!directory.records_dir().exists());

        fs::write(object_path, b"short").unwrap();
        let error = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(error.code, "study_asset_length_mismatch");
        assert!(!directory.records_dir().exists());
    }

    #[test]
    fn post_prepare_catalog_removal_does_not_rewrite_verification_evidence() {
        let directory = TestDirectory::new();
        let (runtime, vault) = fixture_runtime_with_vault(&directory, true);
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        let removal = vault.remove("clip-a").unwrap();
        assert!(removal.removed);
        assert!(removal.object_deleted);

        runtime
            .apply(action_for(
                &created,
                "abort-after-asset-removal",
                1,
                StudyCommandV1::Abort {
                    reason_code: "test-complete".to_owned(),
                },
            ))
            .unwrap();
        let manifest_path = record_file_with_suffix(&directory, ".manifest.json");
        let manifest: ResultManifestV1 =
            serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        assert_eq!(manifest.asset_verification.len(), 1);
        let verification = &manifest.asset_verification[0];
        assert!(verification.verified);
        assert_eq!(verification.expected_sha256, fixture_media_sha256());
        assert_eq!(verification.observed_sha256, Some(fixture_media_sha256()));
        assert_eq!(
            verification.observed_byte_length,
            Some(FIXTURE_MEDIA_BYTES.len() as u64)
        );
    }

    #[test]
    fn terminal_action_atomically_finalizes_csv_and_strict_digest_manifest() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        let prepared = runtime
            .apply(action_for(
                &created,
                "prepare-native",
                1,
                StudyCommandV1::Prepare,
            ))
            .unwrap()
            .state;
        let aborted = runtime
            .apply(action_for(
                &prepared,
                "abort-native",
                2,
                StudyCommandV1::Abort {
                    reason_code: "researcher-stop".to_owned(),
                },
            ))
            .unwrap();
        assert_eq!(aborted.state.phase, RunPhaseV1::Aborted);

        let files = record_files(&directory);
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .all(|path| !path.to_string_lossy().contains(".partial")));
        let csv_path = record_file_with_suffix(&directory, ".csv");
        let manifest_path = record_file_with_suffix(&directory, ".manifest.json");
        let csv_bytes = fs::read(&csv_path).unwrap();
        assert_eq!(
            fs::metadata(&csv_path).unwrap().len(),
            csv_bytes.len() as u64
        );
        let csv = String::from_utf8(csv_bytes.clone()).unwrap();
        let records = parse_csv_records(&csv);
        let final_payload: serde_json::Value =
            serde_json::from_str(&records.last().unwrap()[10]).unwrap();
        assert_eq!(
            final_payload,
            serde_json::to_value(&aborted.events[0].payload).unwrap()
        );
        assert!(records[1..]
            .iter()
            .all(|record| record[1] == aborted.state.authority_generation.to_string()));

        let manifest_json = fs::read_to_string(&manifest_path).unwrap();
        let manifest: ResultManifestV1 = serde_json::from_str(&manifest_json).unwrap();
        manifest.validate().unwrap();
        let record_id = csv_path.file_stem().unwrap().to_str().unwrap();
        assert_eq!(manifest.result_id, format!("result-{record_id}"));
        assert_eq!(manifest.run_id, aborted.state.run_id);
        assert_eq!(manifest.study_id, "parity-fixture");
        assert_eq!(manifest.protocol_hash, aborted.state.protocol_hash);
        assert_eq!(
            manifest.settings_sha256.0,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(manifest.build.platform, PlatformKindV1::Desktop);
        assert_eq!(manifest.build.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            manifest.build.build_commit,
            env!("AFFECT_TRACKER_BUILD_COMMIT")
        );
        assert_eq!(manifest.asset_verification.len(), 1);
        assert!(manifest.asset_verification[0].verified);
        assert_eq!(
            manifest.asset_verification[0].expected_sha256,
            fixture_media_sha256()
        );
        assert_eq!(
            manifest.asset_verification[0].observed_sha256,
            Some(fixture_media_sha256())
        );
        assert_eq!(
            manifest.asset_verification[0].observed_byte_length,
            Some(FIXTURE_MEDIA_BYTES.len() as u64)
        );
        assert_eq!(manifest.resolved_order, aborted.state.resolved_order);
        assert_eq!(
            manifest.completion_status,
            aborted.state.completion_status.unwrap()
        );
        assert_eq!(manifest.event_count, aborted.state.last_event_sequence);
        assert_eq!(manifest.event_count as usize, records.len() - 1);
        assert_eq!(
            manifest.csv_sha256.0,
            format!("{:x}", Sha256::digest(&csv_bytes))
        );
        assert_eq!(
            manifest.finalized_wall_time_utc,
            aborted.events.last().unwrap().wall_time_utc
        );
        let manifest_value: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
        assert!(manifest_value.get("authorityGeneration").is_none());
        assert!(manifest_value.get("recordFilename").is_none());
        assert!(manifest_value.get("recordByteLength").is_none());
        assert_eq!(
            manifest_path.file_name().unwrap().to_str().unwrap(),
            format!("{record_id}.manifest.json")
        );
    }

    #[test]
    fn finalization_failure_is_observable_and_does_not_commit_terminal_state() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        let prepared = runtime
            .apply(action_for(
                &created,
                "prepare-native",
                1,
                StudyCommandV1::Prepare,
            ))
            .unwrap()
            .state;
        let partial_path = record_files(&directory).pop().unwrap();
        let before_failure = fs::read_to_string(&partial_path).unwrap();
        let abort = action_for(
            &prepared,
            "abort-native",
            2,
            StudyCommandV1::Abort {
                reason_code: "injected-finalize-failure".to_owned(),
            },
        );

        runtime.fail_next_finalize_for_test();
        let error = runtime.apply(abort.clone()).unwrap_err();
        assert_eq!(error.code, "study_record_finalize");
        assert_eq!(runtime.state().unwrap(), prepared);
        let partial_files = record_files(&directory);
        assert_eq!(partial_files.len(), 1);
        assert_eq!(partial_files[0], partial_path);
        assert!(partial_path.to_string_lossy().ends_with(".partial.csv"));
        assert_eq!(fs::read_to_string(&partial_path).unwrap(), before_failure);

        let aborted = runtime.apply(abort).unwrap();
        assert_eq!(aborted.state.phase, RunPhaseV1::Aborted);
        let files = record_files(&directory);
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .all(|path| !path.to_string_lossy().contains(".partial")));
    }

    #[test]
    fn manifest_failure_is_observable_and_retry_restores_the_artifact_pair() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        let prepared = runtime
            .apply(action_for(
                &created,
                "prepare-native",
                1,
                StudyCommandV1::Prepare,
            ))
            .unwrap()
            .state;
        let partial_path = record_files(&directory).pop().unwrap();
        let before_failure = fs::read(&partial_path).unwrap();
        let abort = action_for(
            &prepared,
            "abort-native",
            2,
            StudyCommandV1::Abort {
                reason_code: "injected-manifest-failure".to_owned(),
            },
        );

        runtime.fail_next_manifest_finalize_for_test();
        let error = runtime.apply(abort.clone()).unwrap_err();
        assert_eq!(error.code, "study_manifest_finalize");
        assert_eq!(runtime.state().unwrap(), prepared);
        let partial_files = record_files(&directory);
        assert_eq!(partial_files.len(), 1);
        assert_eq!(partial_files[0], partial_path);
        assert_eq!(fs::read(&partial_path).unwrap(), before_failure);

        let aborted = runtime.apply(abort).unwrap();
        assert_eq!(aborted.state.phase, RunPhaseV1::Aborted);
        let files = record_files(&directory);
        assert_eq!(files.len(), 2);
        let csv_path = record_file_with_suffix(&directory, ".csv");
        let manifest_path = record_file_with_suffix(&directory, ".manifest.json");
        let csv = fs::read(&csv_path).unwrap();
        let manifest: ResultManifestV1 =
            serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        assert_eq!(manifest.csv_sha256.0, format!("{:x}", Sha256::digest(csv)));
    }

    #[test]
    fn only_one_nonterminal_run_and_increasing_generations_are_accepted() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let unsafe_generation = runtime
            .prepare_run(
                "parity-fixture",
                1,
                fixture_configuration(),
                Some(JAVASCRIPT_MAX_SAFE_INTEGER + 1),
            )
            .unwrap_err();
        assert_eq!(unsafe_generation.code, "invalid_generation");
        let created = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap();
        let busy = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(8))
            .unwrap_err();
        assert_eq!(busy.code, "active_study_run");

        runtime
            .apply(action_for(
                &created,
                "abort-native",
                1,
                StudyCommandV1::Abort {
                    reason_code: "replace-run".to_owned(),
                },
            ))
            .unwrap();
        let stale = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), Some(7))
            .unwrap_err();
        assert_eq!(stale.code, "stale_generation");
    }

    #[test]
    fn local_runs_receive_increasing_native_generations() {
        let directory = TestDirectory::new();
        let runtime = fixture_runtime(&directory);
        let first = runtime
            .prepare_run("parity-fixture", 1, fixture_configuration(), None)
            .unwrap();
        assert_eq!(first.authority_generation, 1);
        runtime
            .apply(action_for(
                &first,
                "abort-first",
                1,
                StudyCommandV1::Abort {
                    reason_code: "test-complete".to_owned(),
                },
            ))
            .unwrap();

        let mut second_configuration = fixture_configuration();
        second_configuration.run_id = "run-fixture-002".to_owned();
        let second = runtime
            .prepare_run("parity-fixture", 1, second_configuration, None)
            .unwrap();
        assert_eq!(second.authority_generation, 2);
    }
}
