use crate::research_error::{CommandError, ResearchResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[path = "../native-media/runtime_manifest.rs"]
mod runtime_manifest;

use runtime_manifest::{
    verify_runtime_tree, PINNED_ARCHIVE_SHA256, PINNED_LIBVLC_VERSION, PINNED_SOURCE_SHA256,
    PINNED_TARGET, RUNTIME_RELATIVE_ROOT,
};

pub const NATIVE_MEDIA_CAPABILITY_SCHEMA: &str = "affect-research-native-media-capability";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackMode {
    #[default]
    NativeLibvlc,
    UnqualifiedWebview,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackQualification {
    QualifiedNative,
    Unqualified,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeBundleState {
    NotStaged,
    Invalid,
    Verified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaCapability {
    pub schema: &'static str,
    pub version: u32,
    pub backend: &'static str,
    pub pinned_runtime_version: &'static str,
    pub target: &'static str,
    pub runtime_archive_sha256: &'static str,
    pub runtime_source_sha256: &'static str,
    pub default_playback_mode: PlaybackMode,
    pub unqualified_fallback_mode: PlaybackMode,
    pub runtime_bundle_state: RuntimeBundleState,
    pub runtime_integrity_verified: bool,
    pub runtime_file_count: Option<usize>,
    pub runtime_byte_length: Option<u64>,
    pub player_actor_ready: bool,
    pub qualified_start_available: bool,
    pub required_for_qualified_run: bool,
    pub renderer_receives_filesystem_paths: bool,
    pub reason_code: String,
}

#[derive(Debug)]
pub struct NativeMediaService {
    capability: NativeMediaCapability,
}

impl NativeMediaService {
    pub fn inspect(resource_dir: &Path) -> Self {
        let runtime_root = resource_dir.join(RUNTIME_RELATIVE_ROOT);
        let (runtime_bundle_state, runtime_integrity_verified, file_count, byte_length, reason) =
            match verify_runtime_tree(&runtime_root) {
                Ok(verified) => (
                    RuntimeBundleState::Verified,
                    true,
                    Some(verified.file_count),
                    Some(verified.byte_length),
                    "native-player-integration-awaits-explicit-unsafe-approval".to_owned(),
                ),
                Err(error) => {
                    let state = if error.code.as_str() == "runtime-not-staged" {
                        RuntimeBundleState::NotStaged
                    } else {
                        RuntimeBundleState::Invalid
                    };
                    (state, false, None, None, error.code.as_str().to_owned())
                }
            };
        Self {
            capability: NativeMediaCapability {
                schema: NATIVE_MEDIA_CAPABILITY_SCHEMA,
                version: 1,
                backend: "libvlc",
                pinned_runtime_version: PINNED_LIBVLC_VERSION,
                target: PINNED_TARGET,
                runtime_archive_sha256: PINNED_ARCHIVE_SHA256,
                runtime_source_sha256: PINNED_SOURCE_SHA256,
                default_playback_mode: PlaybackMode::NativeLibvlc,
                unqualified_fallback_mode: PlaybackMode::UnqualifiedWebview,
                runtime_bundle_state,
                runtime_integrity_verified,
                runtime_file_count: file_count,
                runtime_byte_length: byte_length,
                // The safe slice deliberately exposes no player as ready. A future actor may
                // set both booleans only after the audited Windows/libVLC boundary is present.
                player_actor_ready: false,
                qualified_start_available: false,
                required_for_qualified_run: true,
                renderer_receives_filesystem_paths: false,
                reason_code: reason,
            },
        }
    }

    #[cfg(test)]
    pub fn unavailable_for_tests() -> Self {
        Self::inspect(Path::new("native-media-runtime-intentionally-absent"))
    }

    pub fn capability(&self) -> NativeMediaCapability {
        self.capability.clone()
    }

    pub fn authorize_playback(
        &self,
        playback_mode: PlaybackMode,
    ) -> ResearchResult<PlaybackQualification> {
        match playback_mode {
            PlaybackMode::NativeLibvlc if self.capability.qualified_start_available => {
                Ok(PlaybackQualification::QualifiedNative)
            }
            PlaybackMode::NativeLibvlc => Err(CommandError::native_media_unavailable(
                &self.capability.reason_code,
            )),
            PlaybackMode::UnqualifiedWebview => Ok(PlaybackQualification::Unqualified),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_runtime_is_truthful_and_native_start_fails_closed() {
        let media = NativeMediaService::unavailable_for_tests();
        let capability = media.capability();
        assert_eq!(capability.default_playback_mode, PlaybackMode::NativeLibvlc);
        assert_eq!(
            capability.runtime_bundle_state,
            RuntimeBundleState::NotStaged
        );
        assert!(!capability.qualified_start_available);
        let error = media
            .authorize_playback(PlaybackMode::NativeLibvlc)
            .unwrap_err();
        assert_eq!(error.code, "native_media_unavailable");
        assert_eq!(
            media
                .authorize_playback(PlaybackMode::UnqualifiedWebview)
                .unwrap(),
            PlaybackQualification::Unqualified
        );
    }

    #[test]
    fn playback_mode_defaults_to_qualified_native() {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default)]
            mode: PlaybackMode,
        }
        let parsed: Wrapper = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.mode, PlaybackMode::NativeLibvlc);
    }

    #[test]
    fn machine_readable_pin_matches_the_compiled_verifier() {
        let pin: serde_json::Value =
            serde_json::from_str(include_str!("../native-media/libvlc-runtime-v1.json")).unwrap();
        assert_eq!(pin["runtimeVersion"], PINNED_LIBVLC_VERSION);
        assert_eq!(pin["target"], PINNED_TARGET);
        assert_eq!(pin["archive"]["sha256"], PINNED_ARCHIVE_SHA256);
        assert_eq!(pin["source"]["sha256"], PINNED_SOURCE_SHA256);
        assert_eq!(
            pin["runtimeTree"]["manifestSha256"],
            runtime_manifest::PINNED_RUNTIME_MANIFEST_SHA256
        );
        assert_eq!(
            pin["runtimeTree"]["fileCount"],
            runtime_manifest::PINNED_RUNTIME_FILE_COUNT
        );
        assert_eq!(
            pin["runtimeTree"]["byteLength"],
            runtime_manifest::PINNED_RUNTIME_BYTE_LENGTH
        );
        assert_eq!(pin["runtimeTree"]["requiredPeMachine"], "0x8664");
        assert_eq!(pin["runtimeTree"]["requiredOptionalHeaderMagic"], "0x020b");
        assert_eq!(pin["productName"], "Affect Research");
    }
}
