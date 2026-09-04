use std::env;
use std::path::Path;
use std::process::Command;

#[path = "native-media/runtime_manifest.rs"]
mod runtime_manifest;

const BUILD_COMMIT_OVERRIDE: &str = "AFFECT_TRACKER_BUILD_COMMIT";
const REQUIRE_NATIVE_MEDIA_RUNTIME: &str = "AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME";

fn main() {
    println!("cargo:rerun-if-env-changed={BUILD_COMMIT_OVERRIDE}");
    println!("cargo:rerun-if-env-changed={REQUIRE_NATIVE_MEDIA_RUNTIME}");
    println!("cargo:rerun-if-changed=native-media");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../desktop");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("Cargo must provide its manifest dir");
    verify_required_native_media_runtime(Path::new(&manifest_dir));
    let build_commit = resolve_build_commit(Path::new(&manifest_dir));
    println!("cargo:rustc-env=AFFECT_TRACKER_BUILD_COMMIT={build_commit}");
    tauri_build::build()
}

fn verify_required_native_media_runtime(manifest_dir: &Path) {
    if env::var(REQUIRE_NATIVE_MEDIA_RUNTIME).ok().as_deref() != Some("1") {
        return;
    }
    assert_eq!(
        env::var("CARGO_CFG_TARGET_OS").ok().as_deref(),
        Some("windows"),
        "required native media runtime supports only the pinned Windows target"
    );
    assert_eq!(
        env::var("CARGO_CFG_TARGET_ARCH").ok().as_deref(),
        Some("x86_64"),
        "required native media runtime supports only the pinned x64 target"
    );
    let root = manifest_dir.join(runtime_manifest::RUNTIME_RELATIVE_ROOT);
    runtime_manifest::verify_runtime_tree(&root).unwrap_or_else(|error| {
        panic!(
            "required native media runtime failed closed: {}",
            error.code.as_str()
        )
    });
    let _pins = (
        runtime_manifest::PINNED_LIBVLC_VERSION,
        runtime_manifest::PINNED_TARGET,
        runtime_manifest::PINNED_ARCHIVE_SHA256,
        runtime_manifest::PINNED_SOURCE_SHA256,
    );
}

fn resolve_build_commit(manifest_dir: &Path) -> String {
    if let Ok(value) = env::var(BUILD_COMMIT_OVERRIDE) {
        validate_commit(&value)
            .unwrap_or_else(|message| panic!("{BUILD_COMMIT_OVERRIDE}: {message}"));
        if let Ok(head) = git_output(manifest_dir, &["rev-parse", "--verify", "HEAD"]) {
            validate_commit(&head).unwrap_or_else(|message| panic!("invalid Git HEAD: {message}"));
            assert_eq!(
                value, head,
                "{BUILD_COMMIT_OVERRIDE} must match Git HEAD when repository metadata is available"
            );
        }
        return match git_is_dirty(manifest_dir) {
            Ok(true) => format!("{value}-dirty"),
            Ok(false) | Err(_) => value,
        };
    }

    let commit = git_output(manifest_dir, &["rev-parse", "--verify", "HEAD"])
        .unwrap_or_else(|message| panic!("cannot derive desktop build commit: {message}"));
    validate_commit(&commit).unwrap_or_else(|message| panic!("invalid Git HEAD: {message}"));
    let dirty = git_is_dirty(manifest_dir)
        .unwrap_or_else(|message| panic!("cannot determine desktop worktree state: {message}"));
    if dirty {
        format!("{commit}-dirty")
    } else {
        commit
    }
}

fn validate_commit(value: &str) -> Result<(), &'static str> {
    if !matches!(value.len(), 40 | 64) {
        return Err("must be an exact 40- or 64-character Git object ID");
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("must contain only lowercase hexadecimal characters");
    }
    Ok(())
}

fn git_is_dirty(manifest_dir: &Path) -> Result<bool, String> {
    git_output(
        manifest_dir,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .map(|output| !output.is_empty())
}

fn git_output(manifest_dir: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(manifest_dir)
        .args(arguments)
        .output()
        .map_err(|_| "Git could not be executed".to_owned())?;
    if !output.status.success() {
        return Err("Git returned a non-success status".to_owned());
    }
    let value =
        String::from_utf8(output.stdout).map_err(|_| "Git returned non-UTF-8 output".to_owned())?;
    Ok(value.trim_end_matches(['\r', '\n']).to_owned())
}
