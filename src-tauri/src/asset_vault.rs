use crate::error::CommandError;
use affect_tracker_study_core::{AssetVerificationV1, MediaAssetV1, Sha256HexV1};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

const ASSET_CATALOG_SCHEMA_V1: &str = "affect-tracker-native-asset-catalog";
const ASSET_CATALOG_VERSION_V1: u16 = 1;
const MAX_MEDIA_BYTES: u64 = 1_099_511_627_776;
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportStudyAssetRequestV1 {
    pub source_path: PathBuf,
    pub asset_id: String,
    pub expected_sha256: Sha256HexV1,
    pub expected_byte_length: u64,
    pub mime_type: String,
    pub container: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetMediaMetadataStatusV1 {
    SuppliedUnprobed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyAssetCatalogEntryV1 {
    pub asset_id: String,
    pub sha256: Sha256HexV1,
    pub byte_length: u64,
    pub mime_type: String,
    pub container: String,
    pub content_address_verified_at_import: bool,
    pub media_metadata_status: AssetMediaMetadataStatusV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyAssetCatalogV1 {
    pub schema: &'static str,
    pub version: u16,
    pub revision: u64,
    pub assets: Vec<StudyAssetCatalogEntryV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetImportDispositionV1 {
    Imported,
    Deduplicated,
    AlreadyPresent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStudyAssetOutcomeV1 {
    pub disposition: AssetImportDispositionV1,
    pub catalog_revision: u64,
    pub asset: StudyAssetCatalogEntryV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStudyAssetOutcomeV1 {
    pub removed: bool,
    pub object_deleted: bool,
    pub remaining_aliases: u32,
    pub catalog_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedAssetCatalogV1 {
    schema: String,
    version: u16,
    revision: u64,
    assets: Vec<StudyAssetCatalogEntryV1>,
}

#[derive(Default)]
struct AssetVaultState {
    revision: u64,
    assets: BTreeMap<String, StudyAssetCatalogEntryV1>,
}

#[derive(Clone)]
struct ObservedContent {
    sha256: Sha256HexV1,
    byte_length: u64,
}

pub struct AssetVault {
    root: PathBuf,
    objects_dir: PathBuf,
    staging_dir: PathBuf,
    catalog_path: PathBuf,
    catalog_temp_path: PathBuf,
    catalog_backup_path: PathBuf,
    state: Mutex<AssetVaultState>,
    #[cfg(test)]
    fail_next_catalog_commit: AtomicBool,
    #[cfg(test)]
    force_cross_device_commit: AtomicBool,
}

impl AssetVault {
    /// Opens the app-owned byte vault and strict metadata catalogue.
    ///
    /// This foundation intentionally exposes no filesystem path or byte-serving
    /// IPC. A future custom opaque media protocol must add bounded HTTP Range
    /// responses without turning the catalogue into an arbitrary file reader.
    pub fn open(root: PathBuf) -> Result<Arc<Self>, CommandError> {
        validate_vault_root(&root)?;
        create_checked_directory(&root)?;
        let root = fs::canonicalize(root).map_err(vault_io_error)?;
        let objects_dir = root.join("objects");
        let staging_dir = root.join("staging");
        create_checked_directory(&objects_dir)?;
        create_checked_directory(&staging_dir)?;
        let catalog_path = root.join("catalog-v1.json");
        let catalog_temp_path = root.join("catalog-v1.json.partial");
        let catalog_backup_path = root.join("catalog-v1.json.backup");
        ensure_safe_vault_descendant(&catalog_path, &root)?;
        ensure_safe_vault_descendant(&catalog_temp_path, &root)?;
        ensure_safe_vault_descendant(&catalog_backup_path, &root)?;
        recover_catalog_transaction(&catalog_path, &catalog_temp_path, &catalog_backup_path)?;
        let state = load_catalog(&catalog_path, &objects_dir)?;
        Ok(Arc::new(Self {
            root,
            objects_dir,
            staging_dir,
            catalog_path,
            catalog_temp_path,
            catalog_backup_path,
            state: Mutex::new(state),
            #[cfg(test)]
            fail_next_catalog_commit: AtomicBool::new(false),
            #[cfg(test)]
            force_cross_device_commit: AtomicBool::new(false),
        }))
    }

    pub fn catalog(&self) -> StudyAssetCatalogV1 {
        let state = self.lock();
        StudyAssetCatalogV1 {
            schema: ASSET_CATALOG_SCHEMA_V1,
            version: ASSET_CATALOG_VERSION_V1,
            revision: state.revision,
            assets: state.assets.values().cloned().collect(),
        }
    }

    /// Re-observes every required content object's bytes while the catalogue
    /// is locked and returns a path-free immutable verification snapshot.
    ///
    /// `SuppliedUnprobed` remains an honest statement about codec, duration,
    /// audio, projection, and stereo metadata. This preflight verifies content
    /// identity only and does not upgrade or imply those media-level claims.
    pub fn verify_study_assets(
        &self,
        assets: &[MediaAssetV1],
    ) -> Result<Vec<AssetVerificationV1>, CommandError> {
        let state = self.lock();
        let mut observed_by_hash = BTreeMap::<String, ObservedContent>::new();
        let mut snapshot = Vec::with_capacity(assets.len());
        for required in assets {
            let entry = state.assets.get(&required.asset_id).ok_or_else(|| {
                CommandError::new(
                    "study_asset_missing",
                    "A required content asset is absent from the native asset vault.",
                )
            })?;
            if !entry.content_address_verified_at_import {
                return Err(CommandError::new(
                    "study_asset_unverified",
                    "A required content asset lacks an import-time content verification receipt.",
                ));
            }
            match entry.media_metadata_status {
                AssetMediaMetadataStatusV1::SuppliedUnprobed => {}
            }
            if entry.sha256 != required.sha256 {
                return Err(CommandError::new(
                    "study_asset_digest_mismatch",
                    "A required asset catalogue digest does not match the published study.",
                ));
            }
            if entry.byte_length != required.byte_length {
                return Err(CommandError::new(
                    "study_asset_length_mismatch",
                    "A required asset catalogue byte length does not match the published study.",
                ));
            }
            if entry.mime_type != required.mime_type || entry.container != required.container {
                return Err(CommandError::new(
                    "study_asset_metadata_mismatch",
                    "A required asset MIME/container declaration does not match the published study.",
                ));
            }

            let observed = if let Some(observed) = observed_by_hash.get(&required.sha256.0) {
                observed.clone()
            } else {
                let path = object_path(&self.objects_dir, &required.sha256)?;
                ensure_safe_vault_descendant(&path, &self.objects_dir)?;
                let observed = observe_content_file(&path)?;
                observed_by_hash.insert(required.sha256.0.clone(), observed.clone());
                observed
            };
            if observed.byte_length != required.byte_length {
                return Err(CommandError::new(
                    "study_asset_length_mismatch",
                    "A required asset's freshly observed byte length does not match the published study.",
                ));
            }
            if observed.sha256 != required.sha256 {
                return Err(CommandError::new(
                    "study_asset_digest_mismatch",
                    "A required asset's freshly observed digest does not match the published study.",
                ));
            }
            snapshot.push(AssetVerificationV1 {
                asset_id: required.asset_id.clone(),
                expected_sha256: required.sha256.clone(),
                expected_byte_length: required.byte_length,
                verified: true,
                observed_sha256: Some(observed.sha256),
                observed_byte_length: Some(observed.byte_length),
            });
        }
        Ok(snapshot)
    }

    pub fn import(
        &self,
        request: ImportStudyAssetRequestV1,
    ) -> Result<ImportStudyAssetOutcomeV1, CommandError> {
        validate_import_request(&request)?;
        validate_source_path(&request.source_path, &self.root)?;
        ensure_safe_vault_descendant(&self.staging_dir, &self.root)?;
        let staged = self.stage_verified_source(&request)?;

        let mut state = self.lock();
        if let Some(existing) = state.assets.get(&request.asset_id) {
            if entry_matches_request(existing, &request) {
                self.verify_object(existing)?;
                return Ok(ImportStudyAssetOutcomeV1 {
                    disposition: AssetImportDispositionV1::AlreadyPresent,
                    catalog_revision: state.revision,
                    asset: existing.clone(),
                });
            }
            return Err(CommandError::new(
                "asset_id_conflict",
                "That opaque asset ID already identifies different immutable content or metadata.",
            ));
        }
        if state.assets.values().any(|entry| {
            entry.sha256 == request.expected_sha256
                && (entry.mime_type != request.mime_type || entry.container != request.container)
        }) {
            return Err(CommandError::new(
                "asset_metadata_conflict",
                "Identical content is already catalogued with different media metadata.",
            ));
        }

        let object_path = object_path(&self.objects_dir, &request.expected_sha256)?;
        ensure_safe_vault_descendant(&object_path, &self.objects_dir)?;
        let object_existed = match fs::symlink_metadata(&object_path) {
            Ok(_) => {
                verify_content_file(
                    &object_path,
                    &request.expected_sha256,
                    request.expected_byte_length,
                )?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.commit_staged_object(
                    staged.path(),
                    &object_path,
                    &request.expected_sha256,
                    request.expected_byte_length,
                )?;
                false
            }
            Err(error) => return Err(vault_io_error(error)),
        };

        let entry = entry_from_request(&request);
        let next_revision = state.revision.checked_add(1).ok_or_else(|| {
            CommandError::new(
                "asset_catalog_revision",
                "The asset catalogue revision cannot advance further.",
            )
        })?;
        let mut next_assets = state.assets.clone();
        next_assets.insert(entry.asset_id.clone(), entry.clone());
        self.persist_catalog(next_revision, &next_assets)?;
        state.revision = next_revision;
        state.assets = next_assets;
        Ok(ImportStudyAssetOutcomeV1 {
            disposition: if object_existed {
                AssetImportDispositionV1::Deduplicated
            } else {
                AssetImportDispositionV1::Imported
            },
            catalog_revision: next_revision,
            asset: entry,
        })
    }

    pub fn remove(&self, asset_id: &str) -> Result<RemoveStudyAssetOutcomeV1, CommandError> {
        validate_asset_id(asset_id)?;
        let mut state = self.lock();
        let Some(removed) = state.assets.get(asset_id).cloned() else {
            return Ok(RemoveStudyAssetOutcomeV1 {
                removed: false,
                object_deleted: false,
                remaining_aliases: 0,
                catalog_revision: state.revision,
            });
        };
        let next_revision = state.revision.checked_add(1).ok_or_else(|| {
            CommandError::new(
                "asset_catalog_revision",
                "The asset catalogue revision cannot advance further.",
            )
        })?;
        let mut next_assets = state.assets.clone();
        next_assets.remove(asset_id);
        let remaining_aliases = next_assets
            .values()
            .filter(|entry| entry.sha256 == removed.sha256)
            .count();
        let remaining_aliases = u32::try_from(remaining_aliases).map_err(|_| {
            CommandError::new(
                "asset_catalog_invalid",
                "The asset catalogue contains too many content aliases.",
            )
        })?;
        self.persist_catalog(next_revision, &next_assets)?;
        state.revision = next_revision;
        state.assets = next_assets;

        let object_deleted = if remaining_aliases == 0 {
            self.remove_unreferenced_object(&removed).unwrap_or(false)
        } else {
            false
        };
        Ok(RemoveStudyAssetOutcomeV1 {
            removed: true,
            object_deleted,
            remaining_aliases,
            catalog_revision: next_revision,
        })
    }

    fn stage_verified_source(
        &self,
        request: &ImportStudyAssetRequestV1,
    ) -> Result<StagedFile, CommandError> {
        let mut source = File::open(&request.source_path).map_err(asset_source_io_error)?;
        if !source.metadata().map_err(asset_source_io_error)?.is_file() {
            return Err(CommandError::new(
                "asset_source_not_file",
                "The selected asset source is not a regular file.",
            ));
        }
        let (stage_path, mut stage) = create_unique_file(&self.staging_dir, "import", ".part")?;
        let staged = StagedFile(stage_path);
        let mut hasher = Sha256::new();
        let mut byte_length = 0_u64;
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        loop {
            let read = source.read(&mut buffer).map_err(asset_source_io_error)?;
            if read == 0 {
                break;
            }
            byte_length = byte_length.checked_add(read as u64).ok_or_else(|| {
                CommandError::new("asset_too_large", "The selected asset is too large.")
            })?;
            if byte_length > request.expected_byte_length || byte_length > MAX_MEDIA_BYTES {
                return Err(CommandError::new(
                    "asset_length_mismatch",
                    "The selected asset byte length does not match its content descriptor.",
                ));
            }
            hasher.update(&buffer[..read]);
            stage.write_all(&buffer[..read]).map_err(vault_io_error)?;
        }
        stage.flush().map_err(vault_io_error)?;
        stage.sync_all().map_err(vault_io_error)?;
        let observed_sha256 = Sha256HexV1(format!("{:x}", hasher.finalize()));
        if byte_length != request.expected_byte_length || observed_sha256 != request.expected_sha256
        {
            return Err(CommandError::new(
                "asset_integrity_mismatch",
                "The selected asset does not match its declared SHA-256 and byte length.",
            ));
        }
        Ok(staged)
    }

    fn commit_staged_object(
        &self,
        stage_path: &Path,
        object_path: &Path,
        expected_sha256: &Sha256HexV1,
        expected_byte_length: u64,
    ) -> Result<(), CommandError> {
        let parent = object_path.parent().ok_or_else(|| {
            CommandError::new(
                "asset_vault_invalid",
                "The asset vault could not derive an object directory.",
            )
        })?;
        ensure_safe_vault_descendant(parent, &self.objects_dir)?;
        create_checked_directory(parent)?;
        #[cfg(test)]
        let force_cross_device = self.force_cross_device_commit.swap(false, Ordering::SeqCst);
        #[cfg(not(test))]
        let force_cross_device = false;
        let rename_result = if force_cross_device {
            Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices))
        } else {
            fs::rename(stage_path, object_path)
        };
        match rename_result {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                let (commit_path, mut commit_file) = create_unique_file(parent, "commit", ".part")?;
                let commit_guard = StagedFile(commit_path.clone());
                let mut source = File::open(stage_path).map_err(vault_io_error)?;
                std::io::copy(&mut source, &mut commit_file).map_err(vault_io_error)?;
                commit_file.flush().map_err(vault_io_error)?;
                commit_file.sync_all().map_err(vault_io_error)?;
                drop(commit_file);
                verify_content_file(&commit_path, expected_sha256, expected_byte_length)?;
                fs::rename(&commit_path, object_path).map_err(vault_io_error)?;
                drop(commit_guard);
                remove_file_if_present(stage_path).map_err(vault_io_error)
            }
            Err(error) => Err(vault_io_error(error)),
        }
    }

    fn verify_object(&self, entry: &StudyAssetCatalogEntryV1) -> Result<(), CommandError> {
        let path = object_path(&self.objects_dir, &entry.sha256)?;
        ensure_safe_vault_descendant(&path, &self.objects_dir)?;
        verify_content_file(&path, &entry.sha256, entry.byte_length)
    }

    fn remove_unreferenced_object(
        &self,
        entry: &StudyAssetCatalogEntryV1,
    ) -> Result<bool, CommandError> {
        let path = object_path(&self.objects_dir, &entry.sha256)?;
        ensure_safe_vault_descendant(&path, &self.objects_dir)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(CommandError::new(
                        "asset_object_unsafe",
                        "The unreferenced asset object is not a safe regular file.",
                    ));
                }
                verify_content_file(&path, &entry.sha256, entry.byte_length)?;
                fs::remove_file(path).map_err(vault_io_error)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(vault_io_error(error)),
        }
    }

    fn persist_catalog(
        &self,
        revision: u64,
        assets: &BTreeMap<String, StudyAssetCatalogEntryV1>,
    ) -> Result<(), CommandError> {
        let persisted = PersistedAssetCatalogV1 {
            schema: ASSET_CATALOG_SCHEMA_V1.to_owned(),
            version: ASSET_CATALOG_VERSION_V1,
            revision,
            assets: assets.values().cloned().collect(),
        };
        validate_persisted_catalog(&persisted)?;
        let mut bytes = serde_json::to_vec_pretty(&persisted).map_err(|_| {
            CommandError::new(
                "asset_catalog_encode",
                "The asset catalogue could not be encoded.",
            )
        })?;
        bytes.push(b'\n');
        if bytes.len() > MAX_CATALOG_BYTES {
            return Err(CommandError::new(
                "asset_catalog_too_large",
                "The asset catalogue exceeds its native persistence limit.",
            ));
        }
        ensure_safe_vault_descendant(&self.catalog_temp_path, &self.root)?;
        ensure_safe_vault_descendant(&self.catalog_path, &self.root)?;
        ensure_safe_vault_descendant(&self.catalog_backup_path, &self.root)?;
        #[cfg(test)]
        if self.fail_next_catalog_commit.swap(false, Ordering::SeqCst) {
            return Err(CommandError::new(
                "asset_catalog_io",
                "The asset catalogue could not be atomically committed.",
            ));
        }
        if let Err(error) = write_new_synced_file(&self.catalog_temp_path, &bytes) {
            let _ = remove_file_if_present(&self.catalog_temp_path);
            return Err(asset_catalog_io_error(error));
        }
        replace_catalog_file(
            &self.catalog_temp_path,
            &self.catalog_path,
            &self.catalog_backup_path,
        )
    }

    fn lock(&self) -> MutexGuard<'_, AssetVaultState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    fn fail_next_catalog_commit_for_test(&self) {
        self.fail_next_catalog_commit.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn force_cross_device_commit_for_test(&self) {
        self.force_cross_device_commit.store(true, Ordering::SeqCst);
    }
}

struct StagedFile(PathBuf);

impl StagedFile {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = remove_file_if_present(&self.0);
    }
}

fn entry_from_request(request: &ImportStudyAssetRequestV1) -> StudyAssetCatalogEntryV1 {
    StudyAssetCatalogEntryV1 {
        asset_id: request.asset_id.clone(),
        sha256: request.expected_sha256.clone(),
        byte_length: request.expected_byte_length,
        mime_type: request.mime_type.clone(),
        container: request.container.clone(),
        content_address_verified_at_import: true,
        media_metadata_status: AssetMediaMetadataStatusV1::SuppliedUnprobed,
    }
}

fn entry_matches_request(
    entry: &StudyAssetCatalogEntryV1,
    request: &ImportStudyAssetRequestV1,
) -> bool {
    entry == &entry_from_request(request)
}

fn validate_import_request(request: &ImportStudyAssetRequestV1) -> Result<(), CommandError> {
    validate_asset_id(&request.asset_id)?;
    validate_sha256(&request.expected_sha256)?;
    if request.expected_byte_length == 0 || request.expected_byte_length > MAX_MEDIA_BYTES {
        return Err(CommandError::new(
            "asset_length_invalid",
            "The expected asset byte length is outside the supported range.",
        ));
    }
    let supported = matches!(
        (request.mime_type.as_str(), request.container.as_str()),
        ("video/mp4", "mp4") | ("video/webm", "webm")
    );
    if !supported {
        return Err(CommandError::new(
            "asset_media_type_unsupported",
            "Only allowlisted MP4 or WebM video MIME/container pairs are accepted.",
        ));
    }
    Ok(())
}

fn validate_asset_id(value: &str) -> Result<(), CommandError> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            "asset_id_invalid",
            "Asset IDs must be 1–64 safe ASCII characters and start alphanumeric.",
        ))
    }
}

fn validate_sha256(value: &Sha256HexV1) -> Result<(), CommandError> {
    if value.0.len() == 64
        && value
            .0
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(CommandError::new(
            "asset_hash_invalid",
            "The expected asset SHA-256 must be 64 lowercase hexadecimal characters.",
        ))
    }
}

fn validate_source_path(source: &Path, vault_root: &Path) -> Result<(), CommandError> {
    if !source.is_absolute()
        || source
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(CommandError::new(
            "asset_source_path_invalid",
            "The selected asset source must be an absolute normalized path.",
        ));
    }
    let metadata = fs::symlink_metadata(source).map_err(asset_source_io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::new(
            "asset_source_symlink",
            "Symbolic links are not accepted as asset sources.",
        ));
    }
    if !metadata.is_file() {
        return Err(CommandError::new(
            "asset_source_not_file",
            "The selected asset source is not a regular file.",
        ));
    }
    let canonical_source = fs::canonicalize(source).map_err(asset_source_io_error)?;
    if canonical_source.starts_with(vault_root) {
        return Err(CommandError::new(
            "asset_source_inside_vault",
            "Vault-owned files cannot be re-imported as external asset sources.",
        ));
    }
    Ok(())
}

fn validate_vault_root(root: &Path) -> Result<(), CommandError> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(CommandError::new(
            "asset_vault_invalid",
            "The application asset-vault root is invalid.",
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CommandError::new(
                "asset_vault_invalid",
                "The application asset-vault root is not a safe directory.",
            ));
        }
    }
    Ok(())
}

fn create_checked_directory(path: &Path) -> Result<(), CommandError> {
    fs::create_dir_all(path).map_err(vault_io_error)?;
    let metadata = fs::symlink_metadata(path).map_err(vault_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CommandError::new(
            "asset_vault_invalid",
            "An asset-vault directory is not a safe local directory.",
        ));
    }
    Ok(())
}

fn ensure_safe_vault_descendant(path: &Path, root: &Path) -> Result<(), CommandError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        CommandError::new(
            "asset_vault_unsafe",
            "An asset-vault operation resolved outside its app-owned root.",
        )
    })?;
    let root_metadata = fs::symlink_metadata(root).map_err(vault_io_error)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(CommandError::new(
            "asset_vault_unsafe",
            "The app-owned asset-vault root is no longer a safe directory.",
        ));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CommandError::new(
                "asset_vault_unsafe",
                "An asset-vault operation contained an unsafe path component.",
            ));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CommandError::new(
                    "asset_vault_unsafe",
                    "An asset-vault path component is a symbolic link.",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(vault_io_error(error)),
        }
    }
    Ok(())
}

fn object_path(objects_dir: &Path, sha256: &Sha256HexV1) -> Result<PathBuf, CommandError> {
    validate_sha256(sha256)?;
    Ok(objects_dir
        .join(&sha256.0[..2])
        .join(format!("{}.blob", sha256.0)))
}

fn create_unique_file(
    directory: &Path,
    prefix: &str,
    suffix: &str,
) -> Result<(PathBuf, File), CommandError> {
    for _ in 0..8 {
        let id = Uuid::new_v4().simple();
        let path = directory.join(format!("{prefix}-{id}{suffix}"));
        match OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(vault_io_error(error)),
        }
    }
    Err(CommandError::new(
        "asset_vault_collision",
        "The asset vault could not allocate a unique staging file.",
    ))
}

fn verify_content_file(
    path: &Path,
    expected_sha256: &Sha256HexV1,
    expected_byte_length: u64,
) -> Result<(), CommandError> {
    let observed = observe_content_file(path)?;
    if observed.byte_length != expected_byte_length || &observed.sha256 != expected_sha256 {
        return Err(CommandError::new(
            "asset_object_invalid",
            "A content-addressed asset object failed integrity verification.",
        ));
    }
    Ok(())
}

fn observe_content_file(path: &Path) -> Result<ObservedContent, CommandError> {
    let metadata = fs::symlink_metadata(path).map_err(vault_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CommandError::new(
            "asset_object_unsafe",
            "A content-addressed asset object is not a safe regular file.",
        ));
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(CommandError::new(
            "asset_object_invalid",
            "A content-addressed asset object exceeds the native media size limit.",
        ));
    }
    let mut file = File::open(path).map_err(vault_io_error)?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(vault_io_error)?;
        if read == 0 {
            break;
        }
        byte_length = byte_length.checked_add(read as u64).ok_or_else(|| {
            CommandError::new("asset_object_invalid", "An asset object is too large.")
        })?;
        if byte_length > MAX_MEDIA_BYTES {
            return Err(CommandError::new(
                "asset_object_invalid",
                "A content-addressed asset object exceeds the native media size limit.",
            ));
        }
        hasher.update(&buffer[..read]);
    }
    let sha256 = Sha256HexV1(format!("{:x}", hasher.finalize()));
    Ok(ObservedContent {
        sha256,
        byte_length,
    })
}

fn load_catalog(catalog_path: &Path, objects_dir: &Path) -> Result<AssetVaultState, CommandError> {
    let bytes = match fs::read(catalog_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AssetVaultState::default());
        }
        Err(error) => return Err(asset_catalog_io_error(error)),
    };
    if bytes.is_empty() || bytes.len() > MAX_CATALOG_BYTES {
        return Err(CommandError::new(
            "asset_catalog_invalid",
            "The persisted asset catalogue is empty or exceeds its size limit.",
        ));
    }
    let persisted: PersistedAssetCatalogV1 = serde_json::from_slice(&bytes).map_err(|_| {
        CommandError::new(
            "asset_catalog_invalid",
            "The persisted asset catalogue does not match its strict schema.",
        )
    })?;
    validate_persisted_catalog(&persisted)?;
    let mut assets = BTreeMap::new();
    for entry in persisted.assets {
        let path = object_path(objects_dir, &entry.sha256)?;
        ensure_safe_vault_descendant(&path, objects_dir)?;
        let metadata = fs::symlink_metadata(path).map_err(asset_catalog_io_error)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != entry.byte_length
        {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "A catalogued asset object is missing or structurally invalid.",
            ));
        }
        if assets.insert(entry.asset_id.clone(), entry).is_some() {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "The persisted asset catalogue contains duplicate asset IDs.",
            ));
        }
    }
    Ok(AssetVaultState {
        revision: persisted.revision,
        assets,
    })
}

fn validate_persisted_catalog(catalog: &PersistedAssetCatalogV1) -> Result<(), CommandError> {
    if catalog.schema != ASSET_CATALOG_SCHEMA_V1 || catalog.version != ASSET_CATALOG_VERSION_V1 {
        return Err(CommandError::new(
            "asset_catalog_invalid",
            "The persisted asset catalogue schema is unsupported.",
        ));
    }
    let mut by_id = BTreeMap::new();
    let mut metadata_by_hash: BTreeMap<&str, (&str, &str)> = BTreeMap::new();
    for entry in &catalog.assets {
        validate_asset_id(&entry.asset_id)?;
        validate_sha256(&entry.sha256)?;
        if entry.byte_length == 0 || entry.byte_length > MAX_MEDIA_BYTES {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "A persisted asset has an invalid byte length.",
            ));
        }
        if !entry.content_address_verified_at_import
            || entry.media_metadata_status != AssetMediaMetadataStatusV1::SuppliedUnprobed
        {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "A persisted asset contains an unsupported verification claim.",
            ));
        }
        let supported = matches!(
            (entry.mime_type.as_str(), entry.container.as_str()),
            ("video/mp4", "mp4") | ("video/webm", "webm")
        );
        if !supported {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "A persisted asset contains an unsupported media type.",
            ));
        }
        if by_id.insert(&entry.asset_id, ()).is_some() {
            return Err(CommandError::new(
                "asset_catalog_invalid",
                "The persisted asset catalogue contains duplicate asset IDs.",
            ));
        }
        if let Some((mime_type, container)) = metadata_by_hash.get(entry.sha256.0.as_str()) {
            if *mime_type != entry.mime_type || *container != entry.container {
                return Err(CommandError::new(
                    "asset_catalog_invalid",
                    "Identical persisted content has conflicting media metadata.",
                ));
            }
        } else {
            metadata_by_hash.insert(
                entry.sha256.0.as_str(),
                (entry.mime_type.as_str(), entry.container.as_str()),
            );
        }
    }
    Ok(())
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

fn safe_catalog_file_exists(path: &Path) -> Result<bool, CommandError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CommandError::new(
                    "asset_catalog_invalid",
                    "An asset catalogue transaction file is not a safe regular file.",
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(asset_catalog_io_error(error)),
    }
}

/// Resolves an interrupted three-file catalogue transaction conservatively.
///
/// A present final file is authoritative. If the final file is absent while a
/// backup exists, the last committed catalogue is restored and any candidate
/// temporary file is discarded. A lone temporary file was never committed and
/// is removed. Content objects are intentionally left in place so a failed
/// catalogue commit is safe and retryable by content hash.
fn recover_catalog_transaction(
    final_path: &Path,
    temp_path: &Path,
    backup_path: &Path,
) -> Result<(), CommandError> {
    let final_exists = safe_catalog_file_exists(final_path)?;
    let temp_exists = safe_catalog_file_exists(temp_path)?;
    let backup_exists = safe_catalog_file_exists(backup_path)?;

    if final_exists {
        if temp_exists {
            remove_file_if_present(temp_path).map_err(asset_catalog_io_error)?;
        }
        if backup_exists {
            remove_file_if_present(backup_path).map_err(asset_catalog_io_error)?;
        }
        return Ok(());
    }

    if backup_exists {
        fs::rename(backup_path, final_path).map_err(|_| {
            CommandError::new(
                "asset_catalog_recovery",
                "The previous asset catalogue could not be restored after an interrupted commit.",
            )
        })?;
    }
    if temp_exists {
        remove_file_if_present(temp_path).map_err(asset_catalog_io_error)?;
    }
    Ok(())
}

/// Atomically promotes a synced candidate without relying on rename-overwrite
/// behavior, which is not portable to Windows. The previous catalogue is first
/// moved aside, then restored if candidate promotion fails.
fn replace_catalog_file(
    temp_path: &Path,
    final_path: &Path,
    backup_path: &Path,
) -> Result<(), CommandError> {
    if !safe_catalog_file_exists(temp_path)? {
        return Err(CommandError::new(
            "asset_catalog_io",
            "The asset catalogue candidate is missing.",
        ));
    }
    let final_exists = safe_catalog_file_exists(final_path)?;
    if safe_catalog_file_exists(backup_path)? {
        remove_file_if_present(backup_path).map_err(asset_catalog_io_error)?;
    }

    if final_exists {
        if let Err(error) = fs::rename(final_path, backup_path) {
            let _ = remove_file_if_present(temp_path);
            return Err(asset_catalog_io_error(error));
        }
    }

    match fs::rename(temp_path, final_path) {
        Ok(()) => {
            // Once the new final file exists it is authoritative. A stale
            // backup is harmless and open() removes it after a crash or a
            // transient cleanup failure.
            if final_exists {
                let _ = remove_file_if_present(backup_path);
            }
            Ok(())
        }
        Err(error) => {
            let mut restoration_failed = false;
            if final_exists && fs::rename(backup_path, final_path).is_err() {
                restoration_failed = true;
            }
            let _ = remove_file_if_present(temp_path);
            if restoration_failed {
                Err(CommandError::new(
                    "asset_catalog_recovery",
                    "The previous asset catalogue could not be restored after a failed commit.",
                ))
            } else {
                Err(asset_catalog_io_error(error))
            }
        }
    }
}

fn vault_io_error(_: std::io::Error) -> CommandError {
    CommandError::new(
        "asset_vault_io",
        "The application could not access its private content-addressed asset vault.",
    )
}

fn asset_source_io_error(_: std::io::Error) -> CommandError {
    CommandError::new(
        "asset_source_io",
        "The application could not read the explicitly selected asset source.",
    )
}

fn asset_catalog_io_error(_: std::io::Error) -> CommandError {
    CommandError::new(
        "asset_catalog_io",
        "The asset catalogue could not be atomically committed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "affect-tracker-asset-vault-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn vault_root(&self) -> PathBuf {
            self.0.join("vault")
        }

        fn source(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(source_path: PathBuf, asset_id: &str, bytes: &[u8]) -> ImportStudyAssetRequestV1 {
        ImportStudyAssetRequestV1 {
            source_path,
            asset_id: asset_id.to_owned(),
            expected_sha256: Sha256HexV1(format!("{:x}", Sha256::digest(bytes))),
            expected_byte_length: bytes.len() as u64,
            mime_type: "video/mp4".to_owned(),
            container: "mp4".to_owned(),
        }
    }

    fn object_file_count(vault: &AssetVault) -> usize {
        fs::read_dir(&vault.objects_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.is_dir())
            .map(|directory| fs::read_dir(directory).unwrap().count())
            .sum()
    }

    fn staging_file_count(vault: &AssetVault) -> usize {
        fs::read_dir(&vault.staging_dir).unwrap().count()
    }

    #[test]
    fn integrity_failure_cleans_stage_and_retry_commits_without_exposing_paths() {
        let directory = TestDirectory::new();
        let bytes = b"small deterministic mp4 fixture";
        let source = directory.source("source.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let mut invalid = request(source.clone(), "clip-a", bytes);
        invalid.expected_sha256 = Sha256HexV1("0".repeat(64));
        let error = vault.import(invalid).unwrap_err();
        assert_eq!(error.code, "asset_integrity_mismatch");
        assert_eq!(staging_file_count(&vault), 0);
        assert!(vault.catalog().assets.is_empty());
        assert!(source.exists());

        let imported = vault
            .import(request(source.clone(), "clip-a", bytes))
            .unwrap();
        assert_eq!(imported.disposition, AssetImportDispositionV1::Imported);
        assert_eq!(object_file_count(&vault), 1);
        assert_eq!(staging_file_count(&vault), 0);
        let serialized = serde_json::to_string(&vault.catalog()).unwrap();
        assert!(!serialized.contains(source.to_string_lossy().as_ref()));
        assert!(!serialized.contains(directory.vault_root().to_string_lossy().as_ref()));
    }

    #[test]
    fn identical_bytes_deduplicate_and_removal_is_explicit_and_reference_safe() {
        let directory = TestDirectory::new();
        let bytes = b"shared content";
        let source = directory.source("shared.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let first = vault
            .import(request(source.clone(), "clip-a", bytes))
            .unwrap();
        assert_eq!(first.catalog_revision, 1);
        let second = vault
            .import(request(source.clone(), "clip-b", bytes))
            .unwrap();
        assert_eq!(second.disposition, AssetImportDispositionV1::Deduplicated);
        assert_eq!(second.catalog_revision, 2);
        assert_eq!(object_file_count(&vault), 1);
        assert_eq!(vault.catalog().assets.len(), 2);
        assert!(!vault.catalog_backup_path.exists());
        let repeated = vault.import(request(source, "clip-b", bytes)).unwrap();
        assert_eq!(
            repeated.disposition,
            AssetImportDispositionV1::AlreadyPresent
        );
        assert_eq!(repeated.catalog_revision, 2);

        let first_removal = vault.remove("clip-a").unwrap();
        assert!(first_removal.removed);
        assert!(!first_removal.object_deleted);
        assert_eq!(first_removal.remaining_aliases, 1);
        assert_eq!(first_removal.catalog_revision, 3);
        assert_eq!(object_file_count(&vault), 1);
        let second_removal = vault.remove("clip-b").unwrap();
        assert!(second_removal.object_deleted);
        assert_eq!(second_removal.remaining_aliases, 0);
        assert_eq!(second_removal.catalog_revision, 4);
        assert_eq!(object_file_count(&vault), 0);
        assert!(!vault.catalog_backup_path.exists());

        let root = vault.root.clone();
        drop(vault);
        let reopened = AssetVault::open(root).unwrap();
        assert_eq!(reopened.catalog().revision, 4);
        assert!(reopened.catalog().assets.is_empty());
    }

    #[test]
    fn interrupted_catalogue_replacement_restores_the_last_committed_revision() {
        let directory = TestDirectory::new();
        let bytes = b"transaction recovery fixture";
        let source = directory.source("transaction.mp4", bytes);
        let root = directory.vault_root();
        let vault = AssetVault::open(root.clone()).unwrap();
        vault.import(request(source, "clip-a", bytes)).unwrap();
        let catalog_path = vault.catalog_path.clone();
        let temp_path = vault.catalog_temp_path.clone();
        let backup_path = vault.catalog_backup_path.clone();
        drop(vault);

        fs::rename(&catalog_path, &backup_path).unwrap();
        fs::write(&temp_path, b"uncommitted candidate").unwrap();
        let recovered = AssetVault::open(root).unwrap();
        assert_eq!(recovered.catalog().revision, 1);
        assert_eq!(recovered.catalog().assets.len(), 1);
        assert!(catalog_path.exists());
        assert!(!temp_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn catalogue_commit_failure_is_retryable_with_a_safe_orphan_object() {
        let directory = TestDirectory::new();
        let bytes = b"catalogue failure fixture";
        let source = directory.source("failure.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        vault.fail_next_catalog_commit_for_test();
        let error = vault
            .import(request(source.clone(), "clip-a", bytes))
            .unwrap_err();
        assert_eq!(error.code, "asset_catalog_io");
        assert!(vault.catalog().assets.is_empty());
        assert_eq!(object_file_count(&vault), 1);
        assert_eq!(staging_file_count(&vault), 0);

        let retry = vault.import(request(source, "clip-a", bytes)).unwrap();
        assert_eq!(retry.disposition, AssetImportDispositionV1::Deduplicated);
        assert_eq!(vault.catalog().assets.len(), 1);
        assert_eq!(object_file_count(&vault), 1);
    }

    #[test]
    fn cross_device_commit_fallback_reverifies_and_atomically_commits() {
        let directory = TestDirectory::new();
        let bytes = b"cross device fixture";
        let source = directory.source("cross-device.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        vault.force_cross_device_commit_for_test();
        let outcome = vault.import(request(source, "clip-a", bytes)).unwrap();
        assert_eq!(outcome.disposition, AssetImportDispositionV1::Imported);
        assert_eq!(object_file_count(&vault), 1);
        assert_eq!(staging_file_count(&vault), 0);
        vault.verify_object(&outcome.asset).unwrap();
    }

    #[test]
    fn traversal_and_vault_owned_sources_are_rejected() {
        let directory = TestDirectory::new();
        let bytes = b"path fixture";
        let source = directory.source("path.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let traversal = directory.0.join("unused").join("..").join("path.mp4");
        let error = vault
            .import(request(traversal, "clip-a", bytes))
            .unwrap_err();
        assert_eq!(error.code, "asset_source_path_invalid");

        let imported = vault.import(request(source, "clip-a", bytes)).unwrap();
        let internal_path = object_path(&vault.objects_dir, &imported.asset.sha256).unwrap();
        let error = vault
            .import(request(internal_path, "clip-b", bytes))
            .unwrap_err();
        assert_eq!(error.code, "asset_source_inside_vault");
        assert_eq!(
            vault.remove("../clip-a").unwrap_err().code,
            "asset_id_invalid"
        );
    }

    #[test]
    fn media_metadata_is_allowlisted_without_claiming_a_probe() {
        let directory = TestDirectory::new();
        let bytes = b"metadata fixture";
        let source = directory.source("metadata.mp4", bytes);
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let mut request = request(source, "clip-a", bytes);
        request.mime_type = "video/quicktime".to_owned();
        request.container = "mov".to_owned();
        let error = vault.import(request).unwrap_err();
        assert_eq!(error.code, "asset_media_type_unsupported");
        assert!(vault.catalog().assets.is_empty());
        assert_eq!(staging_file_count(&vault), 0);
    }

    #[test]
    fn symlink_sources_are_rejected_without_following_them() {
        let directory = TestDirectory::new();
        let bytes = b"symlink fixture";
        let source = directory.source("real.mp4", bytes);
        let linked = directory.0.join("linked.mp4");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&source, &linked) {
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
            {
                return;
            }
            panic!("could not create test symlink: {error}");
        }
        let vault = AssetVault::open(directory.vault_root()).unwrap();
        let error = vault.import(request(linked, "clip-a", bytes)).unwrap_err();
        assert_eq!(error.code, "asset_source_symlink");
    }

    #[test]
    fn catalog_survives_reopen_and_rejects_unprobed_metadata_claims() {
        let directory = TestDirectory::new();
        let bytes = b"reopen fixture";
        let source = directory.source("reopen.mp4", bytes);
        let root = directory.vault_root();
        let vault = AssetVault::open(root.clone()).unwrap();
        vault.import(request(source, "clip-a", bytes)).unwrap();
        drop(vault);

        let reopened = AssetVault::open(root).unwrap();
        let catalog = reopened.catalog();
        assert_eq!(catalog.revision, 1);
        assert_eq!(catalog.assets.len(), 1);
        assert!(catalog.assets[0].content_address_verified_at_import);
        assert_eq!(
            catalog.assets[0].media_metadata_status,
            AssetMediaMetadataStatusV1::SuppliedUnprobed
        );
    }
}
