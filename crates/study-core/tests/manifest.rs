mod support;

use affect_tracker_study_core::*;
use serde_json::json;
use support::{published_study, run_configuration};

fn manifest() -> ResultManifestV1 {
    let study = published_study();
    let configuration = run_configuration();
    ResultManifestV1 {
        schema: RESULT_MANIFEST_SCHEMA_V1.to_owned(),
        version: CONTRACT_VERSION_V1,
        result_id: "result-fixture-001".to_owned(),
        run_id: configuration.run_id.clone(),
        study_id: study.study_id.clone(),
        protocol_hash: study.protocol_hash.clone().unwrap(),
        settings_sha256: study.pinned_settings.portable_settings_sha256.clone(),
        build: PlatformBuildIdentityV1 {
            platform: PlatformKindV1::Desktop,
            app_version: "0.1.0".to_owned(),
            build_commit: "0123456789abcdef".to_owned(),
        },
        asset_verification: vec![AssetVerificationV1 {
            asset_id: "clip-a".to_owned(),
            expected_sha256: study.media[0].sha256.clone(),
            expected_byte_length: study.media[0].byte_length,
            verified: true,
            observed_sha256: Some(study.media[0].sha256.clone()),
            observed_byte_length: Some(study.media[0].byte_length),
        }],
        random_seed: configuration.random_seed.clone(),
        counterbalance_group: configuration.counterbalance_group,
        resolved_order: resolve_study_order(&study, &configuration).unwrap(),
        completion_status: CompletionStatusV1::Completed,
        event_count: 29,
        csv_sha256: Sha256HexV1(
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
        ),
        finalized_wall_time_utc: "2026-09-03T12:30:00Z".to_owned(),
    }
}

#[test]
fn complete_manifest_round_trips_and_validates() {
    let manifest = manifest();
    manifest.validate().unwrap();
    let encoded = serde_json::to_vec(&manifest).unwrap();
    let decoded: ResultManifestV1 = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded, manifest);
}

#[test]
fn manifest_rejects_unverified_claims_and_missing_order_provenance() {
    let mut invalid_asset = manifest();
    invalid_asset.asset_verification[0].observed_byte_length = Some(1);
    assert_eq!(
        invalid_asset.validate().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut missing_seed = manifest();
    missing_seed.random_seed = None;
    assert_eq!(
        missing_seed.validate().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut missing_matrix = manifest();
    missing_matrix.resolved_order[2].matrix_sha256 = None;
    assert_eq!(
        missing_matrix.validate().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut mismatched_group = manifest();
    mismatched_group.resolved_order[2].counterbalance_group = Some(3);
    assert_eq!(
        mismatched_group.validate().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut no_events = manifest();
    no_events.event_count = 0;
    assert_eq!(
        no_events.validate().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );
}

#[test]
fn manifest_json_is_strict_at_every_container() {
    let mut value = serde_json::to_value(manifest()).unwrap();
    value["build"]["executablePath"] = json!("forbidden");
    assert!(serde_json::from_value::<ResultManifestV1>(value).is_err());

    let mut value = serde_json::to_value(manifest()).unwrap();
    value["resolvedOrder"][2]["rowContents"] = json!([0, 1, 2]);
    assert!(serde_json::from_value::<ResultManifestV1>(value).is_err());
}
