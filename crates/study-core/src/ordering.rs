use crate::{
    CoreErrorCodeV1, CoreErrorV1, CoreResult, OrderPolicyV1, ResolvedSectionOrderV1,
    RunConfigurationV1, RunSeedV1, StudyDefinitionV1, StudySectionV1,
};
use sha2::{Digest, Sha256};

pub const FIXED_ORDER_ALGORITHM_V1: &str = "fixed-v1";
pub const SEEDED_ORDER_ALGORITHM_V1: &str = "seeded-sha256-sort-v1";
pub const WILLIAMS_ORDER_ALGORITHM_V1: &str = "williams-balanced-latin-square-v1";
pub const WILLIAMS_MATRIX_HASH_ALGORITHM_V1: &str = "williams-matrix-sha256-v1";
const MAX_ORDER_SIZE: usize = 256;

/// Resolves every section's trial order without reading platform state.
pub fn resolve_study_order(
    study: &StudyDefinitionV1,
    configuration: &RunConfigurationV1,
) -> CoreResult<Vec<ResolvedSectionOrderV1>> {
    study.validate_published()?;
    configuration.validate_for(study)?;
    study
        .sections
        .iter()
        .map(|section| resolve_section_order(section, configuration))
        .collect()
}

/// Deterministically sorts trials by a domain-separated SHA-256 key.
pub fn seeded_trial_order(section: &StudySectionV1, seed: &RunSeedV1) -> CoreResult<Vec<String>> {
    let seed_bytes = seed.bytes()?;
    if section.trials.is_empty() || section.trials.len() > MAX_ORDER_SIZE {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidValue,
            "section.trials",
            format!("must contain 1..={MAX_ORDER_SIZE} trials"),
        ));
    }
    let mut keyed = Vec::with_capacity(section.trials.len());
    for (index, trial) in section.trials.iter().enumerate() {
        let mut digest = Sha256::new();
        digest.update(b"affect-tracker:seeded-shuffle:v1\0");
        digest.update(seed_bytes);
        update_length_prefixed(&mut digest, section.section_id.as_bytes())?;
        update_length_prefixed(&mut digest, trial.trial_id.as_bytes())?;
        let index_u32 = u32::try_from(index).map_err(|_| {
            CoreErrorV1::new(
                CoreErrorCodeV1::LimitExceeded,
                "section.trials",
                "trial index cannot be represented by the ordering algorithm",
            )
        })?;
        digest.update(index_u32.to_be_bytes());
        keyed.push((digest.finalize().to_vec(), index, trial.trial_id.clone()));
    }
    keyed.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    Ok(keyed.into_iter().map(|(_, _, trial_id)| trial_id).collect())
}

/// Generates all Williams rows for `size` conditions.
///
/// Even designs return `size` rows. Odd designs append a reversed companion
/// for every row, returning `2 * size` rows so directed first-order carryover
/// is balanced. Rows contain zero-based condition indices.
pub fn williams_rows(size: usize) -> CoreResult<Vec<Vec<usize>>> {
    if size == 0 || size > MAX_ORDER_SIZE {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidValue,
            "williams.size",
            format!("must be within 1..={MAX_ORDER_SIZE}"),
        ));
    }
    let mut base = Vec::with_capacity(size);
    for position in 0..size {
        let value = if position == 0 {
            0
        } else if !position.is_multiple_of(2) {
            position.div_ceil(2)
        } else {
            size - (position / 2)
        };
        base.push(value);
    }

    let mut rows: Vec<Vec<usize>> = Vec::with_capacity(if size.is_multiple_of(2) {
        size
    } else {
        size * 2
    });
    for offset in 0..size {
        rows.push(base.iter().map(|value| (value + offset) % size).collect());
    }
    if !size.is_multiple_of(2) {
        let companions: Vec<_> = rows
            .iter()
            .map(|row| row.iter().rev().copied().collect())
            .collect();
        rows.extend(companions);
    }
    Ok(rows)
}

/// Hashes the complete Williams matrix using a domain-separated canonical
/// JSON array representation. The digest lets result consumers reconstruct
/// and verify the matrix independently of the selected row.
pub fn williams_matrix_sha256(size: usize) -> CoreResult<crate::Sha256HexV1> {
    let rows = williams_rows(size)?;
    let encoded = serde_json::to_vec(&rows).map_err(|error| {
        CoreErrorV1::new(
            CoreErrorCodeV1::SerializationFailed,
            "williams.matrix",
            format!("could not serialize the Williams matrix: {error}"),
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(b"affect-tracker:williams-matrix:v1\0");
    digest.update(encoded);
    Ok(crate::Sha256HexV1(format!("{:x}", digest.finalize())))
}

fn resolve_section_order(
    section: &StudySectionV1,
    configuration: &RunConfigurationV1,
) -> CoreResult<ResolvedSectionOrderV1> {
    let (algorithm_version, counterbalance_group, matrix_sha256, trial_ids) =
        match section.order_policy {
            OrderPolicyV1::Fixed => (
                FIXED_ORDER_ALGORITHM_V1,
                None,
                None,
                section
                    .trials
                    .iter()
                    .map(|trial| trial.trial_id.clone())
                    .collect(),
            ),
            OrderPolicyV1::SeededShuffle => {
                let seed = configuration.random_seed.as_ref().ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::InvalidValue,
                        "runConfiguration.randomSeed",
                        "is required by a seeded-shuffle section",
                    )
                })?;
                (
                    SEEDED_ORDER_ALGORITHM_V1,
                    None,
                    None,
                    seeded_trial_order(section, seed)?,
                )
            }
            OrderPolicyV1::WilliamsBalancedLatinSquare => {
                let group = configuration.counterbalance_group.ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::InvalidValue,
                        "runConfiguration.counterbalanceGroup",
                        "is required by a Williams section",
                    )
                })?;
                let rows = williams_rows(section.trials.len())?;
                let row = rows.get(usize::from(group - 1)).ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::InvalidValue,
                        "runConfiguration.counterbalanceGroup",
                        format!("group {group} exceeds the {} Williams rows", rows.len()),
                    )
                })?;
                let trials = row
                    .iter()
                    .map(|index| section.trials[*index].trial_id.clone())
                    .collect();
                (
                    WILLIAMS_ORDER_ALGORITHM_V1,
                    Some(group),
                    Some(williams_matrix_sha256(section.trials.len())?),
                    trials,
                )
            }
        };
    Ok(ResolvedSectionOrderV1 {
        section_id: section.section_id.clone(),
        algorithm_version: algorithm_version.to_owned(),
        counterbalance_group,
        matrix_sha256,
        trial_ids,
    })
}

fn update_length_prefixed(digest: &mut Sha256, bytes: &[u8]) -> CoreResult<()> {
    let length = u32::try_from(bytes.len()).map_err(|_| {
        CoreErrorV1::new(
            CoreErrorCodeV1::LimitExceeded,
            "ordering",
            "identifier length cannot be represented by the ordering algorithm",
        )
    })?;
    digest.update(length.to_be_bytes());
    digest.update(bytes);
    Ok(())
}
