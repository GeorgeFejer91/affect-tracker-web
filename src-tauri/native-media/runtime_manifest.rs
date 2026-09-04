use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

pub const PINNED_LIBVLC_VERSION: &str = "3.0.23";
pub const PINNED_TARGET: &str = "win-x64";
pub const RUNTIME_RELATIVE_ROOT: &str = "native-media/runtime/libvlc-3.0.23/win-x64";
pub const RUNTIME_HASH_MANIFEST: &str = "runtime-files.sha256";
pub const PINNED_ARCHIVE_SHA256: &str =
    "992d19dbd0b8a7cde9167d2f7780b1ef6f92acc8a71acfa736101a21f35181e1";
pub const PINNED_SOURCE_SHA256: &str =
    "e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0";

const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 10_000;
const MAX_RUNTIME_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeManifestErrorCode {
    RuntimeMissing,
    ManifestMissing,
    ManifestOversized,
    ManifestMalformed,
    UnsafeManifestPath,
    DuplicateManifestPath,
    RequiredFileMissing,
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
            Self::UnsafeManifestPath => "runtime-hash-manifest-unsafe-path",
            Self::DuplicateManifestPath => "runtime-hash-manifest-duplicate-path",
            Self::RequiredFileMissing => "runtime-required-file-missing",
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
    let root_metadata = fs::symlink_metadata(root).map_err(|error| {
        RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::NotFound {
            RuntimeManifestErrorCode::RuntimeMissing
        } else {
            RuntimeManifestErrorCode::RuntimeIo
        })
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(RuntimeManifestError::new(
            RuntimeManifestErrorCode::RuntimeFileTypeInvalid,
        ));
    }
    let manifest_path = root.join(RUNTIME_HASH_MANIFEST);
    let metadata = fs::metadata(&manifest_path).map_err(|error| {
        RuntimeManifestError::new(if error.kind() == std::io::ErrorKind::NotFound {
            RuntimeManifestErrorCode::ManifestMissing
        } else {
            RuntimeManifestErrorCode::RuntimeIo
        })
    })?;
    if !metadata.is_file() {
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
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::ManifestMalformed))?;
    let entries = parse_manifest(text)?;
    validate_required_entries(&entries)?;

    let observed = enumerate_runtime_files(root)?;
    if observed.len() != entries.len()
        || observed
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
        let file_type = entry
            .file_type()
            .map_err(|_| RuntimeManifestError::new(RuntimeManifestErrorCode::RuntimeIo))?;
        if file_type.is_symlink() {
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

fn relative_path(relative: &str) -> PathBuf {
    relative.split('/').collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn write_fixture(root: &Path) {
        fs::create_dir_all(root.join("plugins/video_output")).unwrap();
        let files = [
            ("libvlc.dll", b"libvlc".as_slice()),
            ("libvlccore.dll", b"libvlccore".as_slice()),
            ("COPYING.LIB", b"LGPL notice".as_slice()),
            (
                "plugins/video_output/libdirect3d11_plugin.dll",
                b"plugin".as_slice(),
            ),
        ];
        let mut lines = Vec::new();
        for (relative, bytes) in files {
            let path = root.join(relative_path(relative));
            fs::write(&path, bytes).unwrap();
            lines.push(format!("{:x} *{relative}", Sha256::digest(bytes)));
        }
        lines.sort();
        let mut manifest = File::create(root.join(RUNTIME_HASH_MANIFEST)).unwrap();
        writeln!(manifest, "{}", lines.join("\n")).unwrap();
    }

    #[test]
    fn verifies_a_complete_exact_runtime_tree() {
        let root = temporary_directory("verified");
        write_fixture(&root);
        let verified = verify_runtime_tree(&root).unwrap();
        assert_eq!(verified.file_count, 4);
        assert!(verified.byte_length > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_tampering_extras_and_traversal() {
        let root = temporary_directory("tamper");
        write_fixture(&root);
        fs::write(root.join("libvlc.dll"), b"changed").unwrap();
        assert_eq!(
            verify_runtime_tree(&root).unwrap_err().code,
            RuntimeManifestErrorCode::RuntimeFileHashMismatch
        );
        write_fixture(&root);
        fs::write(root.join("unexpected.dll"), b"extra").unwrap();
        assert_eq!(
            verify_runtime_tree(&root).unwrap_err().code,
            RuntimeManifestErrorCode::UnexpectedRuntimeFile
        );
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
        fs::remove_dir_all(root).unwrap();
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
    }
}
