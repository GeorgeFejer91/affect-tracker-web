use crate::research_contracts::{
    canonical_json, resolve_assignment_plan_v1, ResearchSettingsV1, ResolvedAssignmentPlanV1,
    RESEARCH_NAMESPACE,
};
use crate::research_error::{CommandError, ResearchResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::http::{header, Method, Request, Response, StatusCode};
use uuid::Uuid;

const MAX_SCAN_DEPTH: usize = 16;
const MAX_SCAN_FILES: usize = 10_000;
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "mov", "m4v", "avi", "mkv"];
const MAX_PROTOCOL_CHUNK: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub selected: bool,
    pub workspace_id: Option<String>,
    pub display_name: Option<String>,
    pub namespace: &'static str,
    pub stimuli_count: usize,
    pub libraries_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedStimulusSummary {
    pub workspace_file_id: String,
    pub display_name: String,
    pub sha256: String,
    pub byte_length: u64,
    pub mime_type: String,
    pub duration_ms: Option<f64>,
    pub decode_status: DecodeStatus,
    pub source: Option<WorkspaceSourceContract>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSourceContract {
    pub kind: &'static str,
    pub relative_path: String,
    pub mime_type: String,
    pub sha256: String,
    pub byte_length: u64,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DecodeStatus {
    Verified,
    Unverified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescanResult {
    pub workspace_id: String,
    pub stimuli: Vec<ScannedStimulusSummary>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportSelectionKind {
    Videos,
    Folder,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUrlReceipt {
    pub media_grant_id: String,
    pub workspace_file_id: String,
    pub media_url: String,
    pub byte_length: u64,
    pub mime_type: String,
    pub duration_ms: Option<f64>,
    pub decode_status: DecodeStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecodeAttestationRequest {
    pub workspace_id: String,
    pub media_grant_id: String,
    pub workspace_file_id: String,
    pub sha256: String,
    pub byte_length: u64,
    pub mime_type: String,
    pub observed_duration_ms: f64,
    pub video_width: u32,
    pub video_height: u32,
    pub muted_playback_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentPlanExportReceipt {
    pub file_name: String,
    pub sha256: String,
    pub byte_length: u64,
    pub row_count: u64,
    pub plan_hash_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReadiness {
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub sufficient: bool,
    pub write_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapabilities {
    pub workspace_file: SourceCapability,
    pub repository_asset: SourceCapability,
    pub youtube: SourceCapability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapability {
    pub supported: bool,
    pub selection_enabled: bool,
    pub reason_code: &'static str,
    pub requires_decode_attestation: bool,
}

pub fn source_capabilities() -> SourceCapabilities {
    SourceCapabilities {
        workspace_file: SourceCapability {
            supported: true,
            selection_enabled: true,
            reason_code: "supported",
            requires_decode_attestation: true,
        },
        repository_asset: SourceCapability {
            supported: false,
            selection_enabled: false,
            reason_code: "repository-assets-not-packaged-in-alpha-1",
            requires_decode_attestation: true,
        },
        youtube: SourceCapability {
            supported: false,
            selection_enabled: false,
            reason_code: "youtube-tauri-feasibility-unqualified",
            requires_decode_attestation: true,
        },
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ScannedStimulus {
    pub id: String,
    pub path: PathBuf,
    pub sha256: String,
    pub byte_length: u64,
    pub mime_type: String,
    pub duration_ms: Option<f64>,
    pub decode_status: DecodeStatus,
}

#[derive(Debug, Clone)]
struct MediaGrant {
    file: Arc<Mutex<File>>,
    workspace_file_id: String,
    sha256: String,
    mime_type: String,
    byte_length: u64,
}

#[derive(Debug)]
struct SelectedWorkspace {
    id: String,
    root: PathBuf,
    display_name: String,
    scanned: Vec<ScannedStimulus>,
    media_grants: HashMap<String, MediaGrant>,
}

#[derive(Debug)]
pub struct WorkspaceService {
    selected: Mutex<Option<SelectedWorkspace>>,
    app_data_namespace: PathBuf,
}

impl WorkspaceService {
    pub fn new(app_data_dir: PathBuf) -> ResearchResult<Self> {
        let namespace = app_data_dir.join("affect-research").join("v1");
        fs::create_dir_all(&namespace).map_err(CommandError::io)?;
        Ok(Self {
            selected: Mutex::new(None),
            app_data_namespace: namespace,
        })
    }

    pub fn status(&self) -> WorkspaceStatus {
        let guard = self.lock_selected();
        match guard.as_ref() {
            Some(workspace) => WorkspaceStatus {
                selected: true,
                workspace_id: Some(workspace.id.clone()),
                display_name: Some(workspace.display_name.clone()),
                namespace: RESEARCH_NAMESPACE,
                stimuli_count: workspace.scanned.len(),
                libraries_ready: self.app_data_namespace.is_dir(),
            },
            None => WorkspaceStatus {
                selected: false,
                workspace_id: None,
                display_name: None,
                namespace: RESEARCH_NAMESPACE,
                stimuli_count: 0,
                libraries_ready: false,
            },
        }
    }

    pub fn select(&self, path: PathBuf) -> ResearchResult<WorkspaceStatus> {
        let root = path
            .canonicalize()
            .map_err(|_| CommandError::forbidden("The selected workspace is unavailable."))?;
        if !root.is_dir() {
            return Err(CommandError::forbidden(
                "The selected workspace must be a directory.",
            ));
        }
        ensure_workspace_libraries(&root)?;
        let display_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Research workspace")
            .to_owned();
        let selected = SelectedWorkspace {
            id: Uuid::new_v4().to_string(),
            root,
            display_name,
            scanned: Vec::new(),
            media_grants: HashMap::new(),
        };
        *self.lock_selected() = Some(selected);
        Ok(self.status())
    }

    pub fn rescan(&self, workspace_id: &str) -> ResearchResult<RescanResult> {
        let mut guard = self.lock_selected();
        let workspace = selected_mut(&mut guard, workspace_id)?;
        ensure_workspace_libraries(&workspace.root)?;
        workspace.scanned = scan_videos(&workspace.root)?;
        workspace.media_grants.clear();
        let stimuli = workspace.scanned.iter().map(scanned_summary).collect();
        Ok(RescanResult {
            workspace_id: workspace.id.clone(),
            stimuli,
        })
    }

    pub fn save_settings(
        &self,
        workspace_id: &str,
        settings: ResearchSettingsV1,
    ) -> ResearchResult<SavedSettingsReceipt> {
        let settings = settings.normalize_and_validate()?;
        let bytes = canonical_json(&settings, &[])?;
        let mut guard = self.lock_selected();
        let workspace = selected_mut(&mut guard, workspace_id)?;
        let file_name = format!("{}.settings.json", settings.experiment.id);
        let target = workspace.root.join("settings").join(&file_name);
        write_replacing(&target, &bytes)?;
        Ok(SavedSettingsReceipt {
            workspace_id: workspace.id.clone(),
            file_name,
            settings_sha256: format!("{:x}", Sha256::digest(&bytes)),
        })
    }

    pub fn storage_readiness(
        &self,
        workspace_id: &str,
        required_bytes: u64,
    ) -> ResearchResult<StorageReadiness> {
        if required_bytes > crate::research_contracts::MAX_SAFE_INTEGER {
            return Err(CommandError::invalid_contract(
                "Estimated storage must fit the exact JSON integer range.",
            ));
        }
        self.with_workspace(workspace_id, |root, _| {
            let available_bytes = fs2::available_space(root)
                .map_err(CommandError::io)?
                .min(crate::research_contracts::MAX_SAFE_INTEGER);
            let probe = root
                .join("recovery")
                .join(format!(".readiness-{}.tmp", Uuid::new_v4()));
            let write_ready = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&probe)?;
                file.write_all(b"affect-research-storage-readiness-v1")?;
                file.sync_all()?;
                drop(file);
                fs::remove_file(&probe)
            })()
            .is_ok();
            let _ = fs::remove_file(&probe);
            Ok(StorageReadiness {
                available_bytes,
                required_bytes,
                sufficient: write_ready && available_bytes >= required_bytes,
                write_ready,
            })
        })
    }

    pub fn import_paths(
        &self,
        workspace_id: &str,
        selections: Vec<PathBuf>,
    ) -> ResearchResult<RescanResult> {
        let destination = self.with_workspace(workspace_id, |root, _| {
            Ok(root.join("stimuli").join("imported"))
        })?;
        fs::create_dir_all(&destination).map_err(CommandError::io)?;
        let destination = destination.canonicalize().map_err(CommandError::io)?;
        let mut sources = collect_import_videos(selections)?;
        sources.sort();
        sources.dedup();
        for source in sources {
            import_video(&source, &destination)?;
        }
        self.rescan(workspace_id)
    }

    pub fn issue_media_url(
        &self,
        workspace_id: &str,
        workspace_file_id: &str,
        expected_sha256: &str,
        expected_byte_length: u64,
        expected_mime_type: &str,
    ) -> ResearchResult<MediaUrlReceipt> {
        let mut guard = self.lock_selected();
        let workspace = selected_mut(&mut guard, workspace_id)?;
        let candidate = scanned_candidate(
            &workspace.scanned,
            workspace_file_id,
            expected_sha256,
            expected_byte_length,
            expected_mime_type,
        )?
        .clone();
        let mut locked_file = open_read_locked(&candidate.path)?;
        let (observed_hash, observed_bytes) = hash_open_file(&mut locked_file)?;
        if observed_hash != expected_sha256 || observed_bytes != expected_byte_length {
            return Err(CommandError::forbidden(
                "The workspace stimulus changed after its latest verified scan.",
            ));
        }
        let token = Uuid::new_v4().simple().to_string();
        workspace.media_grants.insert(
            token.clone(),
            MediaGrant {
                file: Arc::new(Mutex::new(locked_file)),
                workspace_file_id: candidate.id.clone(),
                sha256: candidate.sha256.clone(),
                mime_type: candidate.mime_type.clone(),
                byte_length: candidate.byte_length,
            },
        );
        let media_url = if cfg!(any(target_os = "windows", target_os = "android")) {
            format!("http://research-media.localhost/{token}")
        } else {
            format!("research-media://localhost/{token}")
        };
        Ok(MediaUrlReceipt {
            media_grant_id: token,
            workspace_file_id: workspace_file_id.to_owned(),
            media_url,
            byte_length: candidate.byte_length,
            mime_type: candidate.mime_type.clone(),
            duration_ms: candidate.duration_ms,
            decode_status: candidate.decode_status,
        })
    }

    /// Accepts WebView decode evidence only for the exact locked file grant that
    /// produced the probe URL.  The renderer never supplies a filesystem path.
    pub fn attest_workspace_decode(
        &self,
        request: DecodeAttestationRequest,
    ) -> ResearchResult<ScannedStimulusSummary> {
        if !request.observed_duration_ms.is_finite()
            || !(1.0..=86_400_000.0).contains(&request.observed_duration_ms)
            || request.video_width == 0
            || request.video_height == 0
            || request.video_width > 32_768
            || request.video_height > 32_768
            || !request.muted_playback_ms.is_finite()
            || !(50.0..=5_000.0).contains(&request.muted_playback_ms)
        {
            return Err(CommandError::invalid_contract(
                "Decode attestation requires finite duration, video dimensions, and a short muted playback probe.",
            ));
        }
        let mut guard = self.lock_selected();
        let workspace = selected_mut(&mut guard, &request.workspace_id)?;
        let grant = workspace
            .media_grants
            .get(&request.media_grant_id)
            .ok_or_else(|| CommandError::forbidden("The media probe grant is unavailable."))?;
        if grant.workspace_file_id != request.workspace_file_id
            || grant.sha256 != request.sha256
            || grant.byte_length != request.byte_length
            || grant.mime_type != request.mime_type
        {
            return Err(CommandError::forbidden(
                "Decode evidence does not match the exact native media grant.",
            ));
        }
        let candidate = scanned_candidate(
            &workspace.scanned,
            &request.workspace_file_id,
            &request.sha256,
            request.byte_length,
            &request.mime_type,
        )?;
        let (observed_hash, observed_bytes) = hash_file(&candidate.path)?;
        if observed_hash != request.sha256 || observed_bytes != request.byte_length {
            return Err(CommandError::forbidden(
                "The workspace stimulus changed during decode preflight.",
            ));
        }
        let candidate = workspace
            .scanned
            .iter_mut()
            .find(|entry| entry.id == request.workspace_file_id)
            .expect("candidate was selected from this scan");
        candidate.duration_ms = Some(request.observed_duration_ms);
        candidate.decode_status = DecodeStatus::Verified;
        let summary = scanned_summary(candidate);
        workspace.media_grants.remove(&request.media_grant_id);
        Ok(summary)
    }

    pub fn export_assignment_plan(
        &self,
        workspace_id: &str,
        settings: ResearchSettingsV1,
        plan: ResolvedAssignmentPlanV1,
    ) -> ResearchResult<AssignmentPlanExportReceipt> {
        let settings = settings.normalize_and_validate()?;
        let settings_sha256 = settings.canonical_sha256()?;
        plan.validate(&settings_sha256)?;
        if plan.seed != settings.stimuli.seed
            || plan.condition_order != settings.stimuli.condition_order
            || plan.stimuli != settings.stimuli.items
            || plan.pools != settings.stimuli.pools
            || plan.participant_ids.len() != settings.experiment.participant_count as usize
        {
            return Err(CommandError::invalid_contract(
                "The assignment export does not match the normalized settings.",
            ));
        }
        if plan != resolve_assignment_plan_v1(&settings)? {
            return Err(CommandError::invalid_contract(
                "The assignment export differs from the native balanced-v1 reconstruction.",
            ));
        }
        let row_count = plan
            .assignments
            .iter()
            .map(|assignment| assignment.slots.len() as u64)
            .sum::<u64>();
        if row_count > 10_000_000 {
            return Err(CommandError::invalid_contract(
                "The assignment export exceeds ten million rows.",
            ));
        }
        self.with_workspace(workspace_id, |root, _| {
            let file_name = format!("{}.assignment-plan.csv", settings.experiment.id);
            let target = root.join("settings").join(&file_name);
            let staging = root
                .join("settings")
                .join(format!(".{}.staging", Uuid::new_v4()));
            let mut writer = std::io::BufWriter::new(create_new(&staging)?);
            writer
                .write_all(
                    b"participantId,position,poolId,poolPosition,stimulusId,planHashSha256\n",
                )
                .map_err(CommandError::io)?;
            for assignment in &plan.assignments {
                for slot in &assignment.slots {
                    writeln!(
                        writer,
                        "{},{},{},{},{},{}",
                        assignment.participant_id,
                        slot.position,
                        slot.pool_id,
                        slot.pool_position,
                        slot.stimulus_id,
                        plan.plan_hash_sha256
                    )
                    .map_err(CommandError::io)?;
                }
            }
            writer.flush().map_err(CommandError::io)?;
            writer.get_ref().sync_all().map_err(CommandError::io)?;
            drop(writer);
            replace_with_staging(&staging, &target)?;
            let (sha256, byte_length) = hash_file(&target)?;
            Ok(AssignmentPlanExportReceipt {
                file_name,
                sha256,
                byte_length,
                row_count,
                plan_hash_sha256: plan.plan_hash_sha256.clone(),
            })
        })
    }

    pub(crate) fn protocol_response(
        &self,
        webview_label: &str,
        request: Request<Vec<u8>>,
    ) -> Response<Vec<u8>> {
        if webview_label != "research" || !matches!(*request.method(), Method::GET | Method::HEAD) {
            return protocol_error(StatusCode::FORBIDDEN);
        }
        let token = request.uri().path().trim_matches('/');
        if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return protocol_error(StatusCode::NOT_FOUND);
        }
        let grant = {
            let guard = self.lock_selected();
            guard
                .as_ref()
                .and_then(|workspace| workspace.media_grants.get(token))
                .cloned()
        };
        let Some(grant) = grant else {
            return protocol_error(StatusCode::NOT_FOUND);
        };
        serve_media(grant, request)
    }

    pub(crate) fn with_workspace<T>(
        &self,
        workspace_id: &str,
        action: impl FnOnce(&Path, &[ScannedStimulus]) -> ResearchResult<T>,
    ) -> ResearchResult<T> {
        let guard = self.lock_selected();
        let workspace = selected_ref(&guard, workspace_id)?;
        action(&workspace.root, &workspace.scanned)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn verify_workspace_file(
        &self,
        workspace_id: &str,
        workspace_file_id: &str,
        expected_sha256: &str,
        expected_byte_length: u64,
        expected_relative_path: &str,
        expected_mime_type: &str,
        expected_duration_ms: f64,
    ) -> ResearchResult<()> {
        self.with_workspace(workspace_id, |_, scanned| {
            let candidate = verified_candidate(
                scanned,
                workspace_file_id,
                expected_sha256,
                expected_byte_length,
                expected_relative_path,
                expected_mime_type,
                expected_duration_ms,
            )?;
            let (observed_hash, observed_bytes) = hash_file(&candidate.path)?;
            if observed_hash != expected_sha256 || observed_bytes != expected_byte_length {
                return Err(CommandError::forbidden(
                    "A workspace stimulus changed after the latest scan.",
                ));
            }
            Ok(())
        })
    }

    fn lock_selected(&self) -> MutexGuard<'_, Option<SelectedWorkspace>> {
        self.selected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn mark_first_scanned_verified(&self, duration_ms: f64) {
        if let Some(entry) = self
            .lock_selected()
            .as_mut()
            .and_then(|workspace| workspace.scanned.first_mut())
        {
            entry.duration_ms = Some(duration_ms);
            entry.decode_status = DecodeStatus::Verified;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSettingsReceipt {
    pub workspace_id: String,
    pub file_name: String,
    pub settings_sha256: String,
}

fn selected_ref<'a>(
    guard: &'a MutexGuard<'_, Option<SelectedWorkspace>>,
    workspace_id: &str,
) -> ResearchResult<&'a SelectedWorkspace> {
    let workspace = guard
        .as_ref()
        .ok_or_else(CommandError::workspace_required)?;
    if workspace.id != workspace_id {
        return Err(CommandError::workspace_required());
    }
    Ok(workspace)
}

fn selected_mut<'a>(
    guard: &'a mut MutexGuard<'_, Option<SelectedWorkspace>>,
    workspace_id: &str,
) -> ResearchResult<&'a mut SelectedWorkspace> {
    let workspace = guard
        .as_mut()
        .ok_or_else(CommandError::workspace_required)?;
    if workspace.id != workspace_id {
        return Err(CommandError::workspace_required());
    }
    Ok(workspace)
}

fn ensure_workspace_libraries(root: &Path) -> ResearchResult<()> {
    for name in ["stimuli", "settings", "outputs", "recovery"] {
        let child = root.join(name);
        fs::create_dir_all(&child).map_err(CommandError::io)?;
        let canonical = child.canonicalize().map_err(CommandError::io)?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err(CommandError::forbidden(
                "A workspace library resolves outside the selected parent.",
            ));
        }
    }
    Ok(())
}

fn scan_videos(root: &Path) -> ResearchResult<Vec<ScannedStimulus>> {
    let stimuli_root = root
        .join("stimuli")
        .canonicalize()
        .map_err(CommandError::io)?;
    if !stimuli_root.starts_with(root) {
        return Err(CommandError::forbidden(
            "The stimuli library resolves outside the selected workspace.",
        ));
    }
    let mut queue = VecDeque::from([(stimuli_root.clone(), 0usize)]);
    let mut files = Vec::new();
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > MAX_SCAN_DEPTH {
            return Err(CommandError::forbidden(
                "The stimuli library exceeds the supported folder depth.",
            ));
        }
        for entry in fs::read_dir(&directory).map_err(CommandError::io)? {
            let entry = entry.map_err(CommandError::io)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(CommandError::io)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                let canonical = entry.path().canonicalize().map_err(CommandError::io)?;
                if !canonical.starts_with(&stimuli_root) {
                    return Err(CommandError::forbidden(
                        "A stimuli folder resolves outside the library.",
                    ));
                }
                queue.push_back((canonical, depth + 1));
                continue;
            }
            if !metadata.is_file() || !is_video(&entry.path()) {
                continue;
            }
            if files.len() >= MAX_SCAN_FILES {
                return Err(CommandError::forbidden(
                    "The stimuli library exceeds 10000 video files.",
                ));
            }
            let path = entry.path();
            let (sha256, byte_length) = hash_file(&path)?;
            let mime_type = video_mime_type(&path).to_owned();
            let relative = path
                .strip_prefix(&stimuli_root)
                .map_err(|_| CommandError::forbidden("A stimulus escaped its library."))?;
            let mut opaque_hash = Sha256::new();
            opaque_hash.update(b"affect-research:workspace-file:v1\0");
            opaque_hash.update(relative.to_string_lossy().as_bytes());
            opaque_hash.update([0]);
            opaque_hash.update(sha256.as_bytes());
            let opaque = format!("wf-{:x}", opaque_hash.finalize());
            files.push(ScannedStimulus {
                id: opaque[..27].to_owned(),
                path,
                sha256,
                byte_length,
                mime_type,
                duration_ms: None,
                decode_status: DecodeStatus::Unverified,
            });
        }
    }
    files.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(files)
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn video_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "m4v" => "video/x-m4v",
        _ => "video/mp4",
    }
}

fn scanned_summary(entry: &ScannedStimulus) -> ScannedStimulusSummary {
    let source = entry
        .duration_ms
        .filter(|_| entry.decode_status == DecodeStatus::Verified)
        .map(|duration_ms| WorkspaceSourceContract {
            kind: "workspaceFile",
            relative_path: logical_relative_path(&entry.id),
            mime_type: entry.mime_type.clone(),
            sha256: entry.sha256.clone(),
            byte_length: entry.byte_length,
            duration_ms,
        });
    ScannedStimulusSummary {
        workspace_file_id: entry.id.clone(),
        display_name: entry
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("video")
            .to_owned(),
        sha256: entry.sha256.clone(),
        byte_length: entry.byte_length,
        mime_type: entry.mime_type.clone(),
        duration_ms: entry.duration_ms,
        decode_status: entry.decode_status,
        source,
    }
}

fn scanned_candidate<'a>(
    scanned: &'a [ScannedStimulus],
    workspace_file_id: &str,
    expected_sha256: &str,
    expected_byte_length: u64,
    expected_mime_type: &str,
) -> ResearchResult<&'a ScannedStimulus> {
    scanned
        .iter()
        .find(|entry| {
            entry.id == workspace_file_id
                && entry.sha256 == expected_sha256
                && entry.byte_length == expected_byte_length
                && entry.mime_type == expected_mime_type
        })
        .ok_or_else(|| {
            CommandError::forbidden(
                "The opaque workspace file and metadata do not match the latest native scan.",
            )
        })
}

fn verified_candidate<'a>(
    scanned: &'a [ScannedStimulus],
    workspace_file_id: &str,
    expected_sha256: &str,
    expected_byte_length: u64,
    expected_relative_path: &str,
    expected_mime_type: &str,
    expected_duration_ms: f64,
) -> ResearchResult<&'a ScannedStimulus> {
    if !expected_duration_ms.is_finite() || expected_duration_ms <= 0.0 {
        return Err(CommandError::invalid_contract(
            "A verified workspace stimulus requires a positive duration.",
        ));
    }
    if expected_relative_path != logical_relative_path(workspace_file_id) {
        return Err(CommandError::invalid_contract(
            "Workspace settings must use the opaque logical source locator from Rescan.",
        ));
    }
    scanned
        .iter()
        .find(|entry| {
            entry.id == workspace_file_id
                && entry.sha256 == expected_sha256
                && entry.byte_length == expected_byte_length
                && entry.mime_type == expected_mime_type
                && entry.decode_status == DecodeStatus::Verified
                && entry
                    .duration_ms
                    .is_some_and(|duration| (duration - expected_duration_ms).abs() <= 0.5)
        })
        .ok_or_else(|| {
            CommandError::forbidden(
                "The opaque workspace file and its verified metadata do not match the latest scan.",
            )
        })
}

fn logical_relative_path(workspace_file_id: &str) -> String {
    format!("stimuli/.workspace/{workspace_file_id}")
}

fn collect_import_videos(selections: Vec<PathBuf>) -> ResearchResult<Vec<PathBuf>> {
    let mut videos = Vec::new();
    let mut queue = VecDeque::new();
    for selection in selections {
        let canonical = selection
            .canonicalize()
            .map_err(|_| CommandError::forbidden("An imported selection is unavailable."))?;
        if canonical.is_file() {
            if is_video(&canonical) {
                videos.push(canonical);
            }
        } else if canonical.is_dir() {
            queue.push_back((canonical, 0usize));
        }
    }
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > MAX_SCAN_DEPTH {
            return Err(CommandError::forbidden(
                "The imported folder exceeds the supported recursion depth.",
            ));
        }
        for entry in fs::read_dir(directory).map_err(CommandError::io)? {
            let entry = entry.map_err(CommandError::io)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(CommandError::io)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                queue.push_back((entry.path(), depth + 1));
            } else if metadata.is_file() && is_video(&entry.path()) {
                videos.push(entry.path());
                if videos.len() > MAX_SCAN_FILES {
                    return Err(CommandError::forbidden(
                        "An import may contain at most 10000 videos.",
                    ));
                }
            }
        }
    }
    if videos.is_empty() {
        return Err(CommandError::forbidden(
            "The native selection contained no supported video files.",
        ));
    }
    Ok(videos)
}

fn import_video(source: &Path, destination: &Path) -> ResearchResult<()> {
    let (digest, _) = hash_file(source)?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_file_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "video".to_owned());
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    let target = destination.join(format!("{stem}-{}.{}", &digest[..8], extension));
    if target.exists() {
        let (existing_digest, _) = hash_file(&target)?;
        if existing_digest == digest {
            return Ok(());
        }
        return Err(CommandError::forbidden(
            "An imported video conflicts with an existing curated file.",
        ));
    }
    let staging = destination.join(format!(".{}.import", Uuid::new_v4()));
    let mut input = File::open(source).map_err(CommandError::io)?;
    let mut output = create_new(&staging)?;
    std::io::copy(&mut input, &mut output).map_err(CommandError::io)?;
    output.sync_all().map_err(CommandError::io)?;
    drop(output);
    fs::rename(staging, target).map_err(CommandError::io)
}

fn sanitize_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_owned()
}

fn serve_media(grant: MediaGrant, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut file = grant
        .file
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(metadata) = file.metadata() else {
        return protocol_error(StatusCode::NOT_FOUND);
    };
    if !metadata.is_file() || metadata.len() != grant.byte_length || metadata.len() == 0 {
        return protocol_error(StatusCode::CONFLICT);
    }
    if *request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, grant.mime_type)
            .header(header::CONTENT_LENGTH, metadata.len())
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| protocol_error(StatusCode::INTERNAL_SERVER_ERROR));
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let Some((start, requested_end)) = parse_byte_range(range, metadata.len()) else {
        return protocol_error(StatusCode::RANGE_NOT_SATISFIABLE);
    };
    let end = requested_end.min(start.saturating_add(MAX_PROTOCOL_CHUNK - 1));
    let length = end.saturating_sub(start).saturating_add(1);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return protocol_error(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let mut body = Vec::with_capacity(length as usize);
    if (&mut *file).take(length).read_to_end(&mut body).is_err() || body.len() as u64 != length {
        return protocol_error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let partial = start > 0 || end + 1 < metadata.len() || range.is_some();
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, grant.mime_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", metadata.len()),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| protocol_error(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(target_os = "windows")]
fn open_read_locked(path: &Path) -> ResearchResult<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ: playback may open another reader, but writers/deleters are denied
    // while an ephemeral Research media grant is alive.
    OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(CommandError::io)
}

#[cfg(not(target_os = "windows"))]
fn open_read_locked(path: &Path) -> ResearchResult<File> {
    File::open(path).map_err(CommandError::io)
}

fn hash_open_file(file: &mut File) -> ResearchResult<(String, u64)> {
    file.seek(SeekFrom::Start(0)).map_err(CommandError::io)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut byte_length = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(CommandError::io)?;
        if count == 0 {
            break;
        }
        byte_length = byte_length.saturating_add(count as u64);
        digest.update(&buffer[..count]);
    }
    file.seek(SeekFrom::Start(0)).map_err(CommandError::io)?;
    Ok((format!("{:x}", digest.finalize()), byte_length))
}

fn parse_byte_range(header_value: Option<&str>, length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }
    let Some(value) = header_value else {
        return Some((0, length - 1));
    };
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        return (suffix > 0).then_some((length - suffix, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (end >= start).then_some((start, end))
}

fn protocol_error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn create_new(path: &Path) -> ResearchResult<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(CommandError::io)
}

fn replace_with_staging(staging: &Path, target: &Path) -> ResearchResult<()> {
    if target.exists() {
        let parent = target
            .parent()
            .ok_or_else(|| CommandError::io("The destination library is invalid."))?;
        let backup = parent.join(format!(".{}.backup", Uuid::new_v4()));
        fs::rename(target, &backup).map_err(CommandError::io)?;
        if let Err(error) = fs::rename(staging, target) {
            let _ = fs::rename(&backup, target);
            return Err(CommandError::io(error));
        }
        let _ = fs::remove_file(backup);
    } else {
        fs::rename(staging, target).map_err(CommandError::io)?;
    }
    Ok(())
}

fn hash_file(path: &Path) -> ResearchResult<(String, u64)> {
    let mut file = File::open(path).map_err(CommandError::io)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut byte_length = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(CommandError::io)?;
        if count == 0 {
            break;
        }
        byte_length = byte_length.saturating_add(count as u64);
        digest.update(&buffer[..count]);
    }
    Ok((format!("{:x}", digest.finalize()), byte_length))
}

fn write_replacing(path: &Path, bytes: &[u8]) -> ResearchResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::io("The destination has no parent library."))?;
    let staging = parent.join(format!(".{}.staging", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(CommandError::io)?;
    file.write_all(bytes).map_err(CommandError::io)?;
    file.sync_all().map_err(CommandError::io)?;
    drop(file);
    if path.exists() {
        let backup = parent.join(format!(".{}.backup", Uuid::new_v4()));
        fs::rename(path, &backup).map_err(CommandError::io)?;
        if let Err(error) = fs::rename(&staging, path) {
            let _ = fs::rename(&backup, path);
            return Err(CommandError::io(error));
        }
        let _ = fs::remove_file(backup);
    } else {
        fs::rename(&staging, path).map_err(CommandError::io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tauri_source_picker_exposes_only_the_owned_workspace_source() {
        let capabilities = source_capabilities();
        assert!(capabilities.workspace_file.supported);
        assert!(capabilities.workspace_file.selection_enabled);
        assert!(!capabilities.repository_asset.supported);
        assert!(!capabilities.repository_asset.selection_enabled);
        assert!(!capabilities.youtube.supported);
        assert!(!capabilities.youtube.selection_enabled);
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("affect-research-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn selecting_a_workspace_creates_only_the_four_research_libraries() {
        let base = temporary_directory("workspace");
        let service = WorkspaceService::new(base.join("app-data")).unwrap();
        let workspace = base.join("chosen");
        fs::create_dir(&workspace).unwrap();
        let status = service.select(workspace.clone()).unwrap();
        assert!(status.selected);
        assert!(status.libraries_ready);
        for library in ["stimuli", "settings", "outputs", "recovery"] {
            assert!(workspace.join(library).is_dir());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn scan_ignores_non_video_files_and_never_returns_a_path() {
        let base = temporary_directory("scan");
        let service = WorkspaceService::new(base.join("app-data")).unwrap();
        let workspace = base.join("chosen");
        fs::create_dir(&workspace).unwrap();
        let status = service.select(workspace.clone()).unwrap();
        fs::write(workspace.join("stimuli").join("clip.mp4"), b"video").unwrap();
        fs::write(workspace.join("stimuli").join("notes.txt"), b"private").unwrap();
        let result = service
            .rescan(status.workspace_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(result.stimuli.len(), 1);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("chosen"));
        assert!(!json.contains("clip.mp4/") && !json.contains("stimuli\\"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn namespace_is_dedicated_and_does_not_probe_legacy_storage() {
        let base = temporary_directory("namespace");
        let service = WorkspaceService::new(base.clone()).unwrap();
        assert!(service
            .app_data_namespace
            .ends_with(Path::new("affect-research/v1")));
        assert!(service.app_data_namespace.is_dir());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn storage_readiness_is_path_free_and_performs_a_durable_write_probe() {
        let base = temporary_directory("storage");
        let service = WorkspaceService::new(base.join("app-data")).unwrap();
        let workspace = base.join("chosen");
        fs::create_dir(&workspace).unwrap();
        let status = service.select(workspace.clone()).unwrap();
        let readiness = service
            .storage_readiness(status.workspace_id.as_deref().unwrap(), 1)
            .unwrap();
        assert!(readiness.write_ready);
        assert!(readiness.sufficient);
        assert!(readiness.available_bytes >= readiness.required_bytes);
        assert_eq!(fs::read_dir(workspace.join("recovery")).unwrap().count(), 0);
        assert!(!serde_json::to_string(&readiness)
            .unwrap()
            .contains("chosen"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn media_protocol_uses_only_an_ephemeral_token_and_honors_byte_ranges() {
        let base = temporary_directory("media");
        {
            let service = WorkspaceService::new(base.join("app-data")).unwrap();
            let workspace = base.join("chosen");
            fs::create_dir(&workspace).unwrap();
            let status = service.select(workspace.clone()).unwrap();
            fs::write(workspace.join("stimuli").join("clip.mp4"), b"video").unwrap();
            let scan = service
                .rescan(status.workspace_id.as_deref().unwrap())
                .unwrap();
            let item = &scan.stimuli[0];
            assert_eq!(item.decode_status, DecodeStatus::Unverified);
            assert!(item.source.is_none());
            let receipt = service
                .issue_media_url(
                    status.workspace_id.as_deref().unwrap(),
                    &item.workspace_file_id,
                    &item.sha256,
                    item.byte_length,
                    &item.mime_type,
                )
                .unwrap();
            assert!(!receipt.media_url.contains("clip"));
            assert!(!receipt.media_url.contains("chosen"));
            let request = Request::builder()
                .method(Method::GET)
                .uri(&receipt.media_url)
                .header(header::RANGE, "bytes=1-3")
                .body(Vec::new())
                .unwrap();
            let response = service.protocol_response("research", request);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body(), b"ide");
            let verified = service
                .attest_workspace_decode(DecodeAttestationRequest {
                    workspace_id: status.workspace_id.clone().unwrap(),
                    media_grant_id: receipt.media_grant_id,
                    workspace_file_id: item.workspace_file_id.clone(),
                    sha256: item.sha256.clone(),
                    byte_length: item.byte_length,
                    mime_type: item.mime_type.clone(),
                    observed_duration_ms: 1_000.0,
                    video_width: 1_920,
                    video_height: 1_080,
                    muted_playback_ms: 100.0,
                })
                .unwrap();
            assert_eq!(verified.decode_status, DecodeStatus::Verified);
            assert_eq!(verified.duration_ms, Some(1_000.0));
            assert!(verified.source.is_some());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn range_parser_rejects_multi_ranges_and_bounds_suffixes() {
        assert_eq!(parse_byte_range(Some("bytes=2-5"), 10), Some((2, 5)));
        assert_eq!(parse_byte_range(Some("bytes=-3"), 10), Some((7, 9)));
        assert_eq!(parse_byte_range(Some("bytes=10-"), 10), None);
        assert_eq!(parse_byte_range(Some("bytes=0-1,4-5"), 10), None);
    }
}
