use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const PINNED_LIBVLC_VERSION: &str = "3.0.23";
pub const PINNED_TARGET: &str = "win-x64";
pub const RUNTIME_RELATIVE_ROOT: &str = "native-media/runtime/libvlc-3.0.23/win-x64";
pub const RUNTIME_HASH_MANIFEST: &str = "runtime-files.sha256";
pub const PINNED_ARCHIVE_SHA256: &str =
    "992d19dbd0b8a7cde9167d2f7780b1ef6f92acc8a71acfa736101a21f35181e1";
pub const PINNED_SOURCE_SHA256: &str =
    "e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0";
pub const PINNED_RUNTIME_MANIFEST_SHA256: &str =
    "cab51c65c02bf656d0d77e86b3ec421b130e67b4f7ac52efac20f99cd4be3f26";
pub const PINNED_RUNTIME_FILE_COUNT: usize = 368;
pub const PINNED_RUNTIME_BYTE_LENGTH: u64 = 142_167_916;

const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 10_000;
const MAX_RUNTIME_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 16;
const PE_DOS_HEADER_BYTES: usize = 64;
const PE_POINTER_OFFSET: usize = 0x3c;
const PE_SIGNATURE_AND_COFF_HEADER_BYTES: usize = 24;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const PE32_PLUS_MAGIC: u16 = 0x020b;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeManifestErrorCode {
    RuntimeMissing,
    ManifestMissing,
    ManifestOversized,
    ManifestMalformed,
    RuntimeTreeIdentityMismatch,
    UnsafeManifestPath,
    DuplicateManifestPath,
    RequiredFileMissing,
    RequiredFileFormatInvalid,
    RequiredFileWrongArchitecture,
    UnexpectedRuntimeFile,
    RuntimeFileMissing,
    RuntimeFileTypeInvalid,
    RuntimeFileHashMismatch,
    RuntimeTreeTooLarge,
    RuntimeIo,
}

impl RuntimeManifestErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeMissing => "runtime-not-staged",
            Self::ManifestMissing => "runtime-hash-manifest-missing",
            Self::ManifestOversized => "runtime-hash-manifest-oversized",
            Self::ManifestMalformed => "runtime-hash-manifest-malformed",
            Self::RuntimeTreeIdentityMismatch => "runtime-tree-identity-mismatch",
            Self::UnsafeManifestPath => "runtime-hash-manifest-unsafe-path",
            Self::DuplicateManifestPath => "runtime-hash-manifest-duplicate-path",
            Self::RequiredFileMissing => "runtime-required-file-missing",
            Self::RequiredFileFormatInvalid => "runtime-required-file-format-invalid",
            Self::RequiredFileWrongArchitecture => "runtime-required-file-wrong-architecture",
            Self::UnexpectedRuntimeFile => "runtime-unexpected-file",
            Self::RuntimeFileMissing => "runtime-file-missing",
            Self::RuntimeFileTypeInvalid => "runtime-file-type-invalid",
            Self::RuntimeFileHashMismatch => "runtime-file-hash-mismatch",
            Self::RuntimeTreeTooLarge => "runtime-tree-too-large",
            Self::RuntimeIo => "runtime-io-failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeManifestError {
    pub code: RuntimeManifestErrorCode,
}

impl RuntimeManifestError {
    fn new(code: RuntimeManifestErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedRuntimeBundle {
    pub file_count: usize,
    pub byte_length: u64,
}

pub fn verify_runtime_tree(root: &Path) -> Result<VerifiedRuntimeBundle, RuntimeManifestError> {
    verify_runtime_tree_against(
        root,
        PINNED_RUNTIME_MANIFEST_SHA256,
        PINNED_RUNTIME_FILE_COUNT,
        PINNED_RUNTIME_BYTE_LENGTH,
    )
}

fn verify_runtime_tree_against(
    root: &Path,
    expected_manifest_sha256: &str,
    expected_file_count: usize,
    expected_byte_length: u64,
) -> Result<VerifiedRuntimeBundle, RuntimeManifestError> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| {
        RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::NotFound {
            RuntimeManifestErrorCode::RuntimeMissing
        } else {
            RuntimeManifestErrorCode::RuntimeIo
        })
    })?;
    if !root_metadata.is_dir() || is_link_or_reparse_point(&root_metadata) {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeFileTypeInvalid,
        ));
    }
    let manifest_path = root.join(RUNTIME_HASH_MANIFEST);
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::NotFound {
            RuntimeManifestErrorCode::ManifestMissing
        } else {
            RuntimeManifestErrorCode::RuntimeIo
        })
    })?;
    if !metadata.file_type().is_file() || is_link_or_reparse_point(&metadata) {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::ManifestMissing,
        ));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::ManifestOversized,
        ));
    }
    let bytes = fs::read(&manifest_path)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    if sha256_bytes(&bytes) != expected_manifest_sha256 {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeTreeIdentityMismatch,
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::ManifestMalformed))?;
    let entries = parse_manifest(text)?;
    validate_required_entries(&entries)?;
    if entries.len() != expected_file_count {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeTreeIdentityMismatch,
        ));
    }

    let observed = enumerate_runtime_files(root)?;
    if entries
        .keys()
        .any(|relative| observed.binary_search(relative).is_err())
    {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeFileMissing,
        ));
    }
    if observed
        .iter()
        .any(|relative| !entries.contains_key(relative))
    {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::UnexpectedRuntimeFile,
        ));
    }

    let mut total_bytes = 0_u64;
    for (relative, expected_hash) in &entries {
        let path = root.join(relative_path(relative));
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::NotFound {
                RuntimeManifestErrorCode::RuntimeFileMissing
            } else {
                RuntimeManifestErrorCode::RuntimeIo
            })
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::RuntimeFileTypeInvalid,
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .filter(|value| *value <= MAX_RUNTIME_BYTES)
            .ok_or_else(|| {
                RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeTreeTooLarge)
            })?;
        let observed_hash = sha256_file(&path)?;
        if observed_hash != *expected_hash {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::RuntimeFileHashMismatch,
            ));
        }
    }
    if total_bytes != expected_byte_length {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeTreeIdentityMismatch,
        ));
    }
    for required in ["libvlc.dll", "libvlccore.dll"] {
        validate_pe_x64(&root.join(required))?;
    }
    Ok(VerifiedRuntimeBundle {
        file_count: entries.len(),
        byte_length: total_bytes,
    })
}

fn parse_manifest(text: &str) -> Result<BTreeMap<String, String>, RuntimeManifestError> {
    let mut entries = BTreeMap::new();
    let mut case_folded = HashSet::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if entries.len() >= MAX_RUNTIME_FILES {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::RuntimeTreeTooLarge,
            ));
        }
        let (hash, relative) = line.split_once(" *").ok_or_else(|| {
            RuntimeManifestError::new(RuntimeManifestErrorCode::ManifestMalformed)
        })?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::ManifestMalformed,
            ));
        }
        validate_relative_path(relative)?;
        if !case_folded.insert(relative.to_lowercase())
            || entries
                .insert(relative.to_owned(), hash.to_owned())
                .is_some()
        {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::DuplicateManifestPath,
            ));
        }
    }
    if entries.is_empty() {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::ManifestMalformed,
        ));
    }
    Ok(entries)
}

fn validate_relative_path(relative: &str) -> Result<(), RuntimeManifestError> {
    if relative.is_empty()
        || relative.len() > 512
        || relative.contains('\\')
        || relative.contains(':')
        || relative.starts_with('/')
        || relative.ends_with('/')
        || relative.split('/').any(|part| {
            let device_stem = part
                .split_once('.')
                .map_or(part, |(stem, _)| stem)
                .to_ascii_uppercase();
            part.is_empty()
                || matches!(part, "." | "..")
                || part.ends_with([' ', '.'])
                || matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (device_stem.len() == 4
                    && (device_stem.starts_with("COM") || device_stem.starts_with("LPT"))
                    && matches!(device_stem.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::UnsafeManifestPath,
        ));
    }
    Ok(())
}

fn validate_required_entries(
    entries: &BTreeMap<String, String>,
) -> Result<(), RuntimeManifestError> {
    let has_plugin = entries
        .keys()
        .any(|path| path.starts_with("plugins/") && path.ends_with(".dll"));
    let has_license = entries.keys().any(|path| {
        path.rsplit('/')
            .next()
            .is_some_and(|name| name.to_ascii_lowercase().starts_with("copying"))
    });
    if !entries.contains_key("libvlc.dll")
        || !entries.contains_key("libvlccore.dll")
        || !has_plugin
        || !has_license
    {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileMissing,
        ));
    }
    Ok(())
}

fn enumerate_runtime_files(root: &Path) -> Result<Vec<String>, RuntimeManifestError> {
    let mut files = Vec::new();
    enumerate_directory(root, root, 0, &mut files)?;
    files.sort();
    Ok(files)
}

fn enumerate_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut Vec<String>,
) -> Result<(), RuntimeManifestError> {
    if depth > MAX_TREE_DEPTH || files.len() > MAX_RUNTIME_FILES {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeTreeTooLarge,
        ));
    }
    let entries = fs::read_dir(directory)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    for entry in entries {
        let entry =
            entry.map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
        let file_type = metadata.file_type();
        if is_link_or_reparse_point(&metadata) {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::RuntimeFileTypeInvalid,
            ));
        }
        if file_type.is_dir() {
            enumerate_directory(root, &entry.path(), depth + 1, files)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if relative != RUNTIME_HASH_MANIFEST {
                validate_relative_path(&relative)?;
                if files.len() >= MAX_RUNTIME_FILES {
                    return Err(RuntimeManifestError::new(
                        RuntimeManifestErrorCode::RuntimeTreeTooLarge,
                    ));
                }
                files.push(relative);
            }
        } else {
            return Err(RuntimeManifestError::new(
                RuntimeManifestErrorCode::RuntimeFileTypeInvalid,
            ));
        }
    }
    Ok(())
}

fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_windows_reparse_point(metadata)
}

#[cfg(target_os = "windows")]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn validate_pe_x64(path: &Path) -> Result<(), RuntimeManifestError> {
    let mut file = File::open(path)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    let byte_length = file
        .metadata()
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?
        .len();
    if byte_length < PE_DOS_HEADER_BYTES as u64 {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileFormatInvalid,
        ));
    }

    let mut dos_header = [0_u8; PE_DOS_HEADER_BYTES];
    file.read_exact(&mut dos_header).map_err(|error| {
        RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::UnexpectedEof {
            RuntimeManifestErrorCode::RequiredFileFormatInvalid
        } else {
            RuntimeManifestErrorCode::RuntimeIo
        })
    })?;
    if &dos_header[..2] != b"MZ" {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileFormatInvalid,
        ));
    }

    let pe_offset = u32::from_le_bytes(
        dos_header[PE_POINTER_OFFSET..PE_POINTER_OFFSET + 4]
            .try_into()
            .expect("the PE pointer slice has a fixed four-byte length"),
    ) as u64;
    let header_end = pe_offset
        .checked_add(PE_SIGNATURE_AND_COFF_HEADER_BYTES as u64)
        .and_then(|value| value.checked_add(2))
        .ok_or_else(|| {
            RuntimeManifestError::new(RuntimeManifestErrorCode::RequiredFileFormatInvalid)
        })?;
    if pe_offset < PE_DOS_HEADER_BYTES as u64 || header_end > byte_length {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileFormatInvalid,
        ));
    }

    file.seek(SeekFrom::Start(pe_offset))
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    let mut pe_header = [0_u8; PE_SIGNATURE_AND_COFF_HEADER_BYTES];
    file.read_exact(&mut pe_header)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    if &pe_header[..4] != b"PE\0\0" {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileFormatInvalid,
        ));
    }

    let machine = u16::from_le_bytes([pe_header[4], pe_header[5]]);
    let optional_header_bytes = u16::from_le_bytes([pe_header[20], pe_header[21]]);
    if optional_header_bytes < 2 {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileFormatInvalid,
        ));
    }
    let mut optional_magic = [0_u8; 2];
    file.read_exact(&mut optional_magic)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    let optional_magic = u16::from_le_bytes(optional_magic);
    if machine != IMAGE_FILE_MACHINE_AMD64 || optional_magic != PE32_PLUS_MAGIC {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RequiredFileWrongArchitecture,
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, RuntimeManifestError> {
    let file = File::open(path)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn relative_path(relative: &str) -> PathBuf {
    relative.split('/').collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const IMAGE_FILE_MACHINE_I386: u16 = 0x014c;

    struct FixtureIdentity {
        manifest_sha256: String,
        file_count: usize,
        byte_length: u64,
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "affect-research-native-media-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn pe_fixture(machine: u16, optional_magic: u16, salt: u8) -> Vec<u8> {
        let pe_offset = 0x80_usize;
        let mut bytes = vec![salt; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[PE_POINTER_OFFSET..PE_POINTER_OFFSET + 4]
            .copy_from_slice(&(pe_offset as u32).to_le_bytes());
        bytes[pe_offset..pe_offset + 4].copy_from_slice(b"PE\0\0");
        bytes[pe_offset + 4..pe_offset + 6].copy_from_slice(&machine.to_le_bytes());
        bytes[pe_offset + 20..pe_offset + 22].copy_from_slice(&2_u16.to_le_bytes());
        bytes[pe_offset + 24..pe_offset + 26].copy_from_slice(&optional_magic.to_le_bytes());
        bytes
    }

    fn write_fixture(root: &Path, machine: u16) -> FixtureIdentity {
        fs::create_dir_all(root.join("plugins/video_output")).unwrap();
        fs::write(
            root.join("libvlc.dll"),
            pe_fixture(machine, PE32_PLUS_MAGIC, 0x11),
        )
        .unwrap();
        fs::write(
            root.join("libvlccore.dll"),
            pe_fixture(machine, PE32_PLUS_MAGIC, 0x22),
        )
        .unwrap();
        fs::write(root.join("COPYING.LIB"), b"LGPL notice").unwrap();
        fs::write(
            root.join("plugins/video_output/libdirect3d11_plugin.dll"),
            b"plugin",
        )
        .unwrap();
        write_manifest_for_tree(root)
    }

    fn write_manifest_for_tree(root: &Path) -> FixtureIdentity {
        let files = enumerate_runtime_files(root).unwrap();
        let mut lines = Vec::new();
        let mut byte_length = 0_u64;
        for relative in &files {
            let path = root.join(relative_path(relative));
            byte_length += fs::metadata(&path).unwrap().len();
            lines.push(format!("{} *{relative}", sha256_file(&path).unwrap()));
        }
        let manifest = format!("{}\n", lines.join("\n"));
        fs::write(root.join(RUNTIME_HASH_MANIFEST), manifest.as_bytes()).unwrap();
        FixtureIdentity {
            manifest_sha256: sha256_bytes(manifest.as_bytes()),
            file_count: files.len(),
            byte_length,
        }
    }

    fn verify_fixture(
        root: &Path,
        identity: &FixtureIdentity,
    ) -> Result<VerifiedRuntimeBundle, RuntimeManifestError> {
        verify_runtime_tree_against(
            root,
            &identity.manifest_sha256,
            identity.file_count,
            identity.byte_length,
        )
    }

    #[cfg(target_os = "windows")]
    fn create_directory_junction(target: &Path, link: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd.exe must be available for the Windows junction regression test");
        assert!(
            output.status.success(),
            "junction creation failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn verifies_a_complete_exact_runtime_tree() {
        let root = temporary_directory("verified");
        let identity = write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
        let verified = verify_fixture(&root, &identity).unwrap();
        assert_eq!(verified.file_count, 4);
        assert!(verified.byte_length > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_absent_and_incomplete_runtime_trees() {
        let absent = temporary_directory("absent");
        fs::remove_dir(&absent).unwrap();
        assert_eq!(
            verify_runtime_tree(&absent).unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeMissing
        );

        let missing_manifest = temporary_directory("missing-manifest");
        assert_eq!(
            verify_runtime_tree(&missing_manifest).unwrap_err().code,
            RuntimeManifestErrorCode::ManifestMissing
        );
        fs::remove_dir_all(missing_manifest).unwrap();

        let root = temporary_directory("incomplete");
        let identity = write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
        fs::remove_file(root.join("libvlccore.dll")).unwrap();
        assert_eq!(
            verify_fixture(&root, &identity).unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeFileMissing
        );
        let incomplete_identity = write_manifest_for_tree(&root);
        assert_eq!(
            verify_fixture(&root, &incomplete_identity)
                .unwrap_err()
                .code,
            RuntimeManifestErrorCode::RequiredFileMissing
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unexpected_and_individually_tampered_files() {
        let root = temporary_directory("tamper");
        let identity = write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
        fs::write(root.join("unexpected.dll"), b"extra").unwrap();
        assert_eq!(
            verify_fixture(&root, &identity).unwrap_err().code,
            RuntimeManifestErrorCode::UnexpectedRuntimeFile
        );
        fs::remove_file(root.join("unexpected.dll")).unwrap();
        let mut changed = pe_fixture(IMAGE_FILE_MACHINE_AMD64, PE32_PLUS_MAGIC, 0x11);
        changed.push(0xff);
        fs::write(root.join("libvlc.dll"), changed).unwrap();
        assert_eq!(
            verify_fixture(&root, &identity).unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeFileHashMismatch
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_coordinated_runtime_and_adjacent_manifest_tampering() {
        let root = temporary_directory("coordinated-tamper");
        let pinned_identity = write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
        fs::write(
            root.join("libvlc.dll"),
            pe_fixture(IMAGE_FILE_MACHINE_AMD64, PE32_PLUS_MAGIC, 0x33),
        )
        .unwrap();
        let attacker_identity = write_manifest_for_tree(&root);
        assert_ne!(
            pinned_identity.manifest_sha256,
            attacker_identity.manifest_sha256
        );
        assert_eq!(
            verify_fixture(&root, &pinned_identity).unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeTreeIdentityMismatch
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_wrong_architecture_required_engine_files() {
        for (index, required) in ["libvlc.dll", "libvlccore.dll"].into_iter().enumerate() {
            let root = temporary_directory(&format!("wrong-architecture-{index}"));
            write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
            fs::write(
                root.join(required),
                pe_fixture(IMAGE_FILE_MACHINE_I386, 0x010b, 0x44),
            )
            .unwrap();
            let identity = write_manifest_for_tree(&root);
            assert_eq!(
                verify_fixture(&root, &identity).unwrap_err().code,
                RuntimeManifestErrorCode::RequiredFileWrongArchitecture
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_directory_junction_before_traversal() {
        let root = temporary_directory("directory-junction");
        let identity = write_fixture(&root, IMAGE_FILE_MACHINE_AMD64);
        let external = temporary_directory("directory-junction-target");
        let external_plugins = external.join("plugins");
        fs::rename(root.join("plugins"), &external_plugins).unwrap();
        create_directory_junction(&external_plugins, &root.join("plugins"));

        let result = verify_fixture(&root, &identity);

        fs::remove_dir(root.join("plugins")).unwrap();
        assert!(external_plugins
            .join("video_output/libdirect3d11_plugin.dll")
            .is_file());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
        assert_eq!(
            result.unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeFileTypeInvalid
        );
    }

    #[test]
    fn rejects_manifest_traversal_and_windows_device_paths() {
        let malicious = format!("{} *../outside.dll\n", "0".repeat(64));
        assert_eq!(
            parse_manifest(&malicious).unwrap_err().code,
            RuntimeManifestErrorCode::UnsafeManifestPath
        );
        for reserved in [
            "plugins/CON.dll",
            "plugins/plugin.dll.",
            "plugins/trailing ",
        ] {
            let manifest = format!("{} *{reserved}\n", "0".repeat(64));
            assert_eq!(
                parse_manifest(&manifest).unwrap_err().code,
                RuntimeManifestErrorCode::UnsafeManifestPath
            );
        }
    }

    #[test]
    fn pin_constants_are_exact_and_lowercase() {
        for digest in [PINNED_ARCHIVE_SHA256, PINNED_SOURCE_SHA256] {
            assert_eq!(digest.len(), 64);
            assert!(digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        }
        assert_eq!(PINNED_LIBVLC_VERSION, "3.0.23");
        assert_eq!(PINNED_TARGET, "win-x64");
        assert_eq!(PINNED_RUNTIME_FILE_COUNT, 368);
        assert_eq!(PINNED_RUNTIME_BYTE_LENGTH, 142_167_916);
        assert_eq!(PINNED_RUNTIME_MANIFEST_SHA256.len(), 64);
        assert!(PINNED_RUNTIME_MANIFEST_SHA256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }
}
