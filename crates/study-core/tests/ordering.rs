mod support;

use affect_tracker_study_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use support::{published_study, run_configuration};

#[test]
fn published_fixture_matches_cross_platform_golden_vectors() {
    let expected: Value =
        serde_json::from_str(include_str!("../fixtures/golden-vectors-v1.json")).unwrap();
    let study = published_study();
    let configuration = run_configuration();
    let resolved = resolve_study_order(&study, &configuration).unwrap();

    let actual = json!({
        "protocolHash": protocol_hash(&study).unwrap(),
        "seededOrder": resolved[1].trial_ids,
        "williamsMatrixSha2563": williams_matrix_sha256(3).unwrap(),
        "williamsRows3": williams_rows(3).unwrap(),
        "williamsRows4": williams_rows(4).unwrap(),
        "resolvedOrder": resolved,
    });
    assert_eq!(actual, expected);
}

#[test]
fn seeded_order_is_stable_and_domain_sensitive() {
    let study = published_study();
    let section = &study.sections[1];
    let first = RunSeedV1("00112233445566778899aabbccddeeff".to_owned());
    let second = RunSeedV1("ffeeddccbbaa99887766554433221100".to_owned());

    assert_eq!(
        seeded_trial_order(section, &first).unwrap(),
        seeded_trial_order(section, &first).unwrap()
    );
    assert_ne!(
        seeded_trial_order(section, &first).unwrap(),
        seeded_trial_order(section, &second).unwrap()
    );

    let mut renamed = section.clone();
    renamed.section_id = "other-domain".to_owned();
    assert_ne!(
        seeded_trial_order(section, &first).unwrap(),
        seeded_trial_order(&renamed, &first).unwrap()
    );
}

#[test]
fn seeds_are_exact_canonical_128_bit_hex() {
    for invalid in [
        "00112233445566778899aabbccddeef",
        "00112233445566778899aabbccddeeff0",
        "00112233445566778899AABBCCDDEEFF",
        "00112233445566778899aabbccddeefg",
    ] {
        assert!(RunSeedV1(invalid.to_owned()).bytes().is_err());
    }
    assert_eq!(
        RunSeedV1("000000000000000000000000000000ff".to_owned())
            .bytes()
            .unwrap()[15],
        255
    );
}

#[test]
fn williams_rows_are_permutations_with_balanced_directed_carryover() {
    for size in 2..=9 {
        let rows = williams_rows(size).unwrap();
        assert_eq!(
            rows.len(),
            if size.is_multiple_of(2) {
                size
            } else {
                size * 2
            }
        );

        let mut carryover = HashMap::<(usize, usize), usize>::new();
        for row in &rows {
            let mut sorted = row.clone();
            sorted.sort_unstable();
            assert_eq!(sorted, (0..size).collect::<Vec<_>>());
            for pair in row.windows(2) {
                *carryover.entry((pair[0], pair[1])).or_default() += 1;
            }
        }
        let expected_count = if size.is_multiple_of(2) { 1 } else { 2 };
        for left in 0..size {
            for right in 0..size {
                if left != right {
                    assert_eq!(carryover.get(&(left, right)), Some(&expected_count));
                }
            }
        }
    }
}

#[test]
fn order_generation_rejects_out_of_contract_sizes_and_groups() {
    assert!(williams_rows(0).is_err());
    assert!(williams_rows(257).is_err());

    let study = published_study();
    let mut configuration = run_configuration();
    configuration.counterbalance_group = Some(7);
    assert_eq!(
        resolve_study_order(&study, &configuration)
            .unwrap_err()
            .code,
        CoreErrorCodeV1::InvalidValue
    );
}
