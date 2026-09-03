use crate::canonical::protocol_hash;
use crate::model::*;
use crate::{CoreErrorCodeV1, CoreErrorV1, CoreResult};
use std::collections::{HashMap, HashSet};

const MAX_ASSETS: usize = 128;
const MAX_QUESTIONNAIRES: usize = 64;
const MAX_SECTIONS: usize = 64;
const MAX_TRIALS_PER_SECTION: usize = 256;
const MAX_BLOCKS_PER_TRIAL: usize = 256;
const MAX_TOTAL_BLOCKS: usize = 4_096;
const MAX_ITEMS_PER_QUESTIONNAIRE: usize = 128;
const MAX_OPTIONS_PER_ITEM: usize = 64;
const MAX_ID_BYTES: usize = 64;
const MAX_TITLE_CHARS: usize = 200;
const MAX_LABEL_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 8_192;
const MAX_INSTRUCTION_CHARS: usize = 16_384;
const MAX_MEDIA_BYTES: u64 = 1_099_511_627_776;
const MAX_MEDIA_DURATION_MS: u64 = 86_400_000;

impl StudyDefinitionV1 {
    /// Validates a mutable draft. `protocolHash` may be absent, but if present
    /// it must already match the canonical content hash.
    pub fn validate_draft(&self) -> CoreResult<()> {
        validate_schema(&self.schema, STUDY_SCHEMA_V1, self.version, "study")?;
        validate_id(&self.study_id, "study.studyId")?;
        if self.revision == 0 {
            return invalid("study.revision", "must be at least 1");
        }
        validate_text(&self.title, 1, MAX_TITLE_CHARS, "study.title")?;
        validate_text(
            &self.description,
            0,
            MAX_DESCRIPTION_CHARS,
            "study.description",
        )?;
        validate_settings(&self.pinned_settings)?;
        validate_unique_capabilities(&self.required_capabilities, "study.requiredCapabilities")?;
        ensure_count(self.media.len(), MAX_ASSETS, "study.media")?;
        ensure_count(
            self.questionnaires.len(),
            MAX_QUESTIONNAIRES,
            "study.questionnaires",
        )?;
        if self.sections.is_empty() {
            return invalid("study.sections", "must contain at least one section");
        }
        ensure_count(self.sections.len(), MAX_SECTIONS, "study.sections")?;

        let mut asset_ids = HashSet::new();
        for (index, asset) in self.media.iter().enumerate() {
            let path = format!("study.media[{index}]");
            validate_media_asset(asset, &path)?;
            insert_unique(&mut asset_ids, &asset.asset_id, &format!("{path}.assetId"))?;
        }

        let mut questionnaire_ids = HashSet::new();
        for (index, questionnaire) in self.questionnaires.iter().enumerate() {
            let path = format!("study.questionnaires[{index}]");
            validate_questionnaire(questionnaire, &path)?;
            insert_unique(
                &mut questionnaire_ids,
                &questionnaire.questionnaire_id,
                &format!("{path}.questionnaireId"),
            )?;
        }

        let mut section_ids = HashSet::new();
        let mut trial_ids = HashSet::new();
        let mut block_ids = HashSet::new();
        let mut total_blocks = 0_usize;
        let mut completion_blocks = 0_usize;

        for (section_index, section) in self.sections.iter().enumerate() {
            let section_path = format!("study.sections[{section_index}]");
            validate_id(&section.section_id, &format!("{section_path}.sectionId"))?;
            insert_unique(
                &mut section_ids,
                &section.section_id,
                &format!("{section_path}.sectionId"),
            )?;
            validate_text(
                &section.title,
                1,
                MAX_TITLE_CHARS,
                &format!("{section_path}.title"),
            )?;
            if section.trials.is_empty() {
                return invalid(
                    format!("{section_path}.trials"),
                    "must contain at least one trial",
                );
            }
            ensure_count(
                section.trials.len(),
                MAX_TRIALS_PER_SECTION,
                &format!("{section_path}.trials"),
            )?;

            for (trial_index, trial) in section.trials.iter().enumerate() {
                let trial_path = format!("{section_path}.trials[{trial_index}]");
                validate_id(&trial.trial_id, &format!("{trial_path}.trialId"))?;
                insert_unique(
                    &mut trial_ids,
                    &trial.trial_id,
                    &format!("{trial_path}.trialId"),
                )?;
                validate_text(
                    &trial.label,
                    1,
                    MAX_LABEL_CHARS,
                    &format!("{trial_path}.label"),
                )?;
                if trial.blocks.is_empty() {
                    return invalid(
                        format!("{trial_path}.blocks"),
                        "must contain at least one block",
                    );
                }
                ensure_count(
                    trial.blocks.len(),
                    MAX_BLOCKS_PER_TRIAL,
                    &format!("{trial_path}.blocks"),
                )?;
                total_blocks = total_blocks
                    .checked_add(trial.blocks.len())
                    .ok_or_else(|| {
                        CoreErrorV1::new(
                            CoreErrorCodeV1::LimitExceeded,
                            "study.sections",
                            "total block count overflowed",
                        )
                    })?;
                if total_blocks > MAX_TOTAL_BLOCKS {
                    return limit("study.sections", MAX_TOTAL_BLOCKS);
                }

                for (block_index, block) in trial.blocks.iter().enumerate() {
                    let block_path = format!("{trial_path}.blocks[{block_index}]");
                    validate_id(block.block_id(), &format!("{block_path}.blockId"))?;
                    insert_unique(
                        &mut block_ids,
                        block.block_id(),
                        &format!("{block_path}.blockId"),
                    )?;
                    validate_block(
                        block,
                        &block_path,
                        &asset_ids,
                        &questionnaire_ids,
                        &self.media,
                    )?;
                    if matches!(block, StudyBlockV1::Completion { .. }) {
                        completion_blocks += 1;
                        if self.completion_policy.require_completion_block && trial.run_if.is_some()
                        {
                            return invalid(
                                format!("{trial_path}.runIf"),
                                "trial containing a required completion block must be unconditional",
                            );
                        }
                        let is_terminal = section_index + 1 == self.sections.len()
                            && trial_index + 1 == section.trials.len()
                            && block_index + 1 == trial.blocks.len()
                            && section.order_policy == OrderPolicyV1::Fixed;
                        if !is_terminal {
                            return invalid(
                                &block_path,
                                "completion must be the final authored block in a fixed-order section",
                            );
                        }
                    }
                }
            }
        }

        if self.completion_policy.require_completion_block && completion_blocks == 0 {
            return invalid(
                "study.completionPolicy.requireCompletionBlock",
                "requires at least one completion block",
            );
        }
        if completion_blocks > 1 {
            return invalid(
                "study.sections",
                "must contain at most one completion block",
            );
        }

        self.validate_trial_conditions()?;

        if let Some(declared) = &self.protocol_hash {
            validate_sha256(declared, "study.protocolHash")?;
            let calculated = protocol_hash(self)?;
            if declared != &calculated {
                return Err(CoreErrorV1::new(
                    CoreErrorCodeV1::HashMismatch,
                    "study.protocolHash",
                    format!(
                        "does not match canonical content; expected {}",
                        calculated.as_str()
                    ),
                ));
            }
        }
        Ok(())
    }

    fn validate_trial_conditions(&self) -> CoreResult<()> {
        let mut questionnaire_blocks = HashMap::<&str, (usize, usize, &str)>::new();
        for (section_index, section) in self.sections.iter().enumerate() {
            for (trial_index, trial) in section.trials.iter().enumerate() {
                for block in &trial.blocks {
                    if let StudyBlockV1::Questionnaire {
                        block_id,
                        questionnaire_id,
                    } = block
                    {
                        questionnaire_blocks
                            .insert(block_id, (section_index, trial_index, questionnaire_id));
                    }
                }
            }
        }

        for (target_section_index, section) in self.sections.iter().enumerate() {
            for (target_trial_index, trial) in section.trials.iter().enumerate() {
                let Some(condition) = &trial.run_if else {
                    continue;
                };
                let path = format!(
                    "study.sections[{target_section_index}].trials[{target_trial_index}].runIf"
                );
                validate_id(
                    condition.questionnaire_block_id(),
                    &format!("{path}.questionnaireBlockId"),
                )?;
                validate_id(condition.item_id(), &format!("{path}.itemId"))?;
                let (source_section_index, source_trial_index, questionnaire_id) =
                    questionnaire_blocks
                        .get(condition.questionnaire_block_id())
                        .copied()
                        .ok_or_else(|| {
                            CoreErrorV1::new(
                                CoreErrorCodeV1::MissingReference,
                                format!("{path}.questionnaireBlockId"),
                                "must identify a questionnaire block",
                            )
                        })?;
                if source_section_index >= target_section_index {
                    return invalid(
                        format!("{path}.questionnaireBlockId"),
                        "must identify a questionnaire block in an earlier section",
                    );
                }
                let source_section = &self.sections[source_section_index];
                if source_section.order_policy != OrderPolicyV1::Fixed {
                    return invalid(
                        format!("{path}.questionnaireBlockId"),
                        "source questionnaire section must use fixed ordering",
                    );
                }
                if source_section.trials[source_trial_index].run_if.is_some() {
                    return invalid(
                        format!("{path}.questionnaireBlockId"),
                        "source questionnaire trial must be unconditional",
                    );
                }
                let questionnaire = self.questionnaire(questionnaire_id).ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::MissingReference,
                        format!("{path}.questionnaireBlockId"),
                        "source questionnaire definition is unavailable",
                    )
                })?;
                let item = questionnaire
                    .items
                    .iter()
                    .find(|item| item.item_id() == condition.item_id())
                    .ok_or_else(|| {
                        CoreErrorV1::new(
                            CoreErrorCodeV1::MissingReference,
                            format!("{path}.itemId"),
                            "must identify an item in the source questionnaire",
                        )
                    })?;
                if !item.required() {
                    return invalid(
                        format!("{path}.itemId"),
                        "conditional source item must be required so its answer is guaranteed",
                    );
                }
                validate_trial_condition_for_item(condition, item, &path)?;
            }
        }
        Ok(())
    }

    /// Validates an immutable/published definition and requires its hash.
    pub fn validate_published(&self) -> CoreResult<()> {
        self.validate_draft()?;
        if self.protocol_hash.is_none() {
            return invalid("study.protocolHash", "is required for a published study");
        }
        Ok(())
    }

    /// Returns a validated immutable revision with the canonical protocol hash.
    pub fn published(mut self) -> CoreResult<Self> {
        self.protocol_hash = None;
        self.validate_draft()?;
        self.protocol_hash = Some(protocol_hash(&self)?);
        self.validate_published()?;
        Ok(self)
    }

    #[must_use]
    pub fn questionnaire(&self, questionnaire_id: &str) -> Option<&QuestionnaireV1> {
        self.questionnaires
            .iter()
            .find(|candidate| candidate.questionnaire_id == questionnaire_id)
    }

    #[must_use]
    pub fn media_asset(&self, asset_id: &str) -> Option<&MediaAssetV1> {
        self.media
            .iter()
            .find(|candidate| candidate.asset_id == asset_id)
    }

    #[must_use]
    pub fn required_runtime_capabilities(&self) -> HashSet<PlatformCapabilityV1> {
        let mut capabilities: HashSet<PlatformCapabilityV1> =
            self.required_capabilities.iter().copied().collect();
        for asset in &self.media {
            capabilities.extend(asset.required_capabilities.iter().copied());
            capabilities.insert(PlatformCapabilityV1::ContentAddressedMedia);
            match asset.projection {
                MediaProjectionV1::Flat => {
                    capabilities.insert(PlatformCapabilityV1::FlatVideo);
                }
                MediaProjectionV1::Equirectangular180 => {
                    capabilities.insert(PlatformCapabilityV1::Equirectangular180);
                }
                MediaProjectionV1::Equirectangular360 => {
                    capabilities.insert(PlatformCapabilityV1::Equirectangular360);
                }
            }
            match asset.stereo_layout {
                StereoLayoutV1::Mono => {}
                StereoLayoutV1::SideBySideLeftRight => {
                    capabilities.insert(PlatformCapabilityV1::SideBySideStereo);
                }
                StereoLayoutV1::TopBottom => {
                    capabilities.insert(PlatformCapabilityV1::TopBottomStereo);
                }
            }
        }
        for section in &self.sections {
            for trial in &section.trials {
                for block in &trial.blocks {
                    match block {
                        StudyBlockV1::Instruction {
                            presentation: InstructionPresentationV1::FaceFlubberComparison,
                            ..
                        } => {
                            capabilities.insert(PlatformCapabilityV1::FaceFlubberComparison);
                        }
                        StudyBlockV1::Questionnaire { .. } => {
                            capabilities.insert(PlatformCapabilityV1::Questionnaires);
                        }
                        StudyBlockV1::Video {
                            source: MediaSourceV1::Youtube { .. },
                            ..
                        } => {
                            capabilities.insert(PlatformCapabilityV1::YoutubeEmbed);
                        }
                        _ => {}
                    }
                }
            }
        }
        capabilities
    }
}

impl RunConfigurationV1 {
    pub fn validate_for(&self, study: &StudyDefinitionV1) -> CoreResult<()> {
        validate_schema(
            &self.schema,
            RUN_CONFIGURATION_SCHEMA_V1,
            self.version,
            "runConfiguration",
        )?;
        validate_id(&self.run_id, "runConfiguration.runId")?;
        if let Some(participant_code) = &self.participant_code {
            validate_text(
                participant_code,
                1,
                MAX_ID_BYTES,
                "runConfiguration.participantCode",
            )?;
        }
        validate_unique_capabilities(
            &self.platform.capabilities,
            "runConfiguration.platform.capabilities",
        )?;
        validate_health(&self.initial_health, "runConfiguration.initialHealth")?;

        let has_seeded = study
            .sections
            .iter()
            .any(|section| section.order_policy == OrderPolicyV1::SeededShuffle);
        let has_williams = study
            .sections
            .iter()
            .any(|section| section.order_policy == OrderPolicyV1::WilliamsBalancedLatinSquare);

        match (&self.random_seed, has_seeded) {
            (Some(seed), true) => {
                seed.bytes()?;
            }
            (None, true) => {
                return invalid(
                    "runConfiguration.randomSeed",
                    "is required by a seeded-shuffle section",
                );
            }
            (Some(_), false) => {
                return invalid(
                    "runConfiguration.randomSeed",
                    "must be absent when no section uses seeded shuffle",
                );
            }
            (None, false) => {}
        }

        match (self.counterbalance_group, has_williams) {
            (Some(group), true) => {
                if group == 0 {
                    return invalid(
                        "runConfiguration.counterbalanceGroup",
                        "is one-based and must be at least 1",
                    );
                }
                for section in study.sections.iter().filter(|section| {
                    section.order_policy == OrderPolicyV1::WilliamsBalancedLatinSquare
                }) {
                    let row_count = if section.trials.len().is_multiple_of(2) {
                        section.trials.len()
                    } else {
                        section.trials.len() * 2
                    };
                    if usize::from(group) > row_count {
                        return invalid(
                            "runConfiguration.counterbalanceGroup",
                            format!(
                                "group {group} exceeds the {row_count} rows for section {}",
                                section.section_id
                            ),
                        );
                    }
                }
            }
            (None, true) => {
                return invalid(
                    "runConfiguration.counterbalanceGroup",
                    "is required by a Williams section",
                );
            }
            (Some(_), false) => {
                return invalid(
                    "runConfiguration.counterbalanceGroup",
                    "must be absent when no section uses Williams ordering",
                );
            }
            (None, false) => {}
        }

        let available: HashSet<_> = self.platform.capabilities.iter().copied().collect();
        let mut missing: Vec<_> = study
            .required_runtime_capabilities()
            .difference(&available)
            .copied()
            .collect();
        missing.sort_by_key(|capability| format!("{capability:?}"));
        if !missing.is_empty() {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::CapabilityMissing,
                "runConfiguration.platform.capabilities",
                format!("missing required capabilities: {missing:?}"),
            ));
        }
        Ok(())
    }
}

impl StudyActionV1 {
    pub fn validate_shape(&self) -> CoreResult<()> {
        validate_schema(&self.schema, STUDY_ACTION_SCHEMA_V1, self.version, "action")?;
        validate_id(&self.action_id, "action.actionId")?;
        validate_id(&self.run_id, "action.runId")?;
        if let Some(block_id) = &self.precondition.expected_block_id {
            validate_id(block_id, "action.precondition.expectedBlockId")?;
        }
        validate_clock(&self.clock, "action.clock")?;
        match &self.command {
            StudyCommandV1::ApplyPinnedSettings { settings_sha256 } => {
                validate_sha256(settings_sha256, "action.command.settingsSha256")?;
            }
            StudyCommandV1::SetAffectCalibration { point } => {
                validate_affect_point(point, "action.command.point")?;
            }
            StudyCommandV1::Pause { reason_code }
            | StudyCommandV1::RetryBlock { reason_code }
            | StudyCommandV1::Stop { reason_code }
            | StudyCommandV1::Abort { reason_code } => {
                validate_id(reason_code, "action.command.reasonCode")?;
            }
            StudyCommandV1::SubmitQuestionnaire {
                questionnaire_id,
                answers,
            } => {
                validate_id(questionnaire_id, "action.command.questionnaireId")?;
                ensure_count(
                    answers.len(),
                    MAX_ITEMS_PER_QUESTIONNAIRE,
                    "action.command.answers",
                )?;
            }
            StudyCommandV1::RecordAffectSample { sample } => {
                validate_sample(sample, "action.command.sample")?;
            }
            StudyCommandV1::ReportMediaTimeline { anchor } => {
                validate_media_anchor(anchor, "action.command.anchor")?;
            }
            StudyCommandV1::ReportHealth { health } => {
                validate_health(health, "action.command.health")?;
            }
            StudyCommandV1::ReportStall { stall } => {
                validate_id(&stall.code, "action.command.stall.code")?;
            }
            StudyCommandV1::Prepare
            | StudyCommandV1::ResetAffect
            | StudyCommandV1::Arm
            | StudyCommandV1::Start
            | StudyCommandV1::Resume
            | StudyCommandV1::Advance
            | StudyCommandV1::ClearStall
            | StudyCommandV1::Finalize => {}
        }
        Ok(())
    }
}

impl ResultManifestV1 {
    pub fn validate(&self) -> CoreResult<()> {
        validate_schema(
            &self.schema,
            RESULT_MANIFEST_SCHEMA_V1,
            self.version,
            "resultManifest",
        )?;
        validate_id(&self.result_id, "resultManifest.resultId")?;
        validate_id(&self.run_id, "resultManifest.runId")?;
        validate_id(&self.study_id, "resultManifest.studyId")?;
        validate_sha256(&self.protocol_hash, "resultManifest.protocolHash")?;
        validate_sha256(&self.settings_sha256, "resultManifest.settingsSha256")?;
        validate_sha256(&self.csv_sha256, "resultManifest.csvSha256")?;
        validate_text(
            &self.build.app_version,
            1,
            MAX_LABEL_CHARS,
            "resultManifest.build.appVersion",
        )?;
        validate_text(
            &self.build.build_commit,
            1,
            128,
            "resultManifest.build.buildCommit",
        )?;
        validate_wall_time(
            &self.finalized_wall_time_utc,
            "resultManifest.finalizedWallTimeUtc",
        )?;
        if self.event_count == 0 {
            return invalid("resultManifest.eventCount", "must be at least 1");
        }
        if let Some(seed) = &self.random_seed {
            seed.bytes()?;
        }
        if self.counterbalance_group == Some(0) {
            return invalid(
                "resultManifest.counterbalanceGroup",
                "is one-based and must be at least 1",
            );
        }
        ensure_count(
            self.asset_verification.len(),
            MAX_ASSETS,
            "resultManifest.assetVerification",
        )?;
        let mut asset_ids = HashSet::new();
        for (index, asset) in self.asset_verification.iter().enumerate() {
            let path = format!("resultManifest.assetVerification[{index}]");
            validate_id(&asset.asset_id, &format!("{path}.assetId"))?;
            insert_unique(&mut asset_ids, &asset.asset_id, &format!("{path}.assetId"))?;
            validate_sha256(&asset.expected_sha256, &format!("{path}.expectedSha256"))?;
            if asset.expected_byte_length == 0 || asset.expected_byte_length > MAX_MEDIA_BYTES {
                return invalid(
                    format!("{path}.expectedByteLength"),
                    format!("must be within 1..={MAX_MEDIA_BYTES}"),
                );
            }
            if let Some(observed) = &asset.observed_sha256 {
                validate_sha256(observed, &format!("{path}.observedSha256"))?;
            }
            if asset
                .observed_byte_length
                .is_some_and(|length| length == 0 || length > MAX_MEDIA_BYTES)
            {
                return invalid(
                    format!("{path}.observedByteLength"),
                    format!("must be within 1..={MAX_MEDIA_BYTES}"),
                );
            }
            if asset.verified
                && (asset.observed_sha256.as_ref() != Some(&asset.expected_sha256)
                    || asset.observed_byte_length != Some(asset.expected_byte_length))
            {
                return invalid(
                    format!("{path}.verified"),
                    "verified assets must match both expected hash and byte length",
                );
            }
        }
        if self.resolved_order.is_empty() {
            return invalid("resultManifest.resolvedOrder", "must not be empty");
        }
        ensure_count(
            self.resolved_order.len(),
            MAX_SECTIONS,
            "resultManifest.resolvedOrder",
        )?;
        let mut section_ids = HashSet::new();
        let mut has_seeded = false;
        let mut has_williams = false;
        for (index, section) in self.resolved_order.iter().enumerate() {
            let path = format!("resultManifest.resolvedOrder[{index}]");
            validate_resolved_order(section, &path)?;
            insert_unique(
                &mut section_ids,
                &section.section_id,
                &format!("{path}.sectionId"),
            )?;
            has_seeded |= section.algorithm_version == crate::SEEDED_ORDER_ALGORITHM_V1;
            has_williams |= section.algorithm_version == crate::WILLIAMS_ORDER_ALGORITHM_V1;
            if section.algorithm_version == crate::WILLIAMS_ORDER_ALGORITHM_V1
                && section.counterbalance_group != self.counterbalance_group
            {
                return invalid(
                    format!("{path}.counterbalanceGroup"),
                    "must match the manifest counterbalance group",
                );
            }
        }
        match (has_seeded, self.random_seed.is_some()) {
            (true, false) => {
                return invalid(
                    "resultManifest.randomSeed",
                    "is required when resolved order uses seeded shuffle",
                );
            }
            (false, true) => {
                return invalid(
                    "resultManifest.randomSeed",
                    "must be absent when resolved order does not use seeded shuffle",
                );
            }
            _ => {}
        }
        match (has_williams, self.counterbalance_group.is_some()) {
            (true, false) => {
                return invalid(
                    "resultManifest.counterbalanceGroup",
                    "is required when resolved order uses Williams counterbalancing",
                );
            }
            (false, true) => {
                return invalid(
                    "resultManifest.counterbalanceGroup",
                    "must be absent when resolved order does not use Williams counterbalancing",
                );
            }
            _ => {}
        }
        Ok(())
    }
}

pub(crate) fn validate_questionnaire_answers(
    questionnaire: &QuestionnaireV1,
    answers: &[QuestionnaireAnswerV1],
) -> CoreResult<()> {
    let items: HashMap<_, _> = questionnaire
        .items
        .iter()
        .map(|item| (item.item_id(), item))
        .collect();
    let mut answer_ids = HashSet::new();
    for (index, answer) in answers.iter().enumerate() {
        let item_id = answer.item_id();
        validate_id(item_id, &format!("action.command.answers[{index}].itemId"))?;
        insert_unique(
            &mut answer_ids,
            item_id,
            &format!("action.command.answers[{index}].itemId"),
        )?;
        let item = items.get(item_id).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::MissingReference,
                format!("action.command.answers[{index}].itemId"),
                format!("unknown questionnaire item {item_id}"),
            )
        })?;
        validate_answer(item, answer, index)?;
    }
    for item in &questionnaire.items {
        if item.required() && !answer_ids.contains(item.item_id()) {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::IncompleteQuestionnaire,
                "action.command.answers",
                format!("missing required response for {}", item.item_id()),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_media_anchor(anchor: &MediaTimelineAnchorV1, path: &str) -> CoreResult<()> {
    if !anchor.playback_rate.is_finite() || !(0.1..=8.0).contains(&anchor.playback_rate) {
        return invalid(
            format!("{path}.playbackRate"),
            "must be finite and within 0.1..=8.0",
        );
    }
    Ok(())
}

pub(crate) fn validate_health(health: &RunHealthV1, path: &str) -> CoreResult<()> {
    for (name, component) in [
        ("storage", &health.storage),
        ("input", &health.input),
        ("lsl", &health.lsl),
    ] {
        if let Some(code) = &component.detail_code {
            validate_id(code, &format!("{path}.{name}.detailCode"))?;
        }
    }
    Ok(())
}

pub(crate) fn validate_clock(clock: &EventClockV1, path: &str) -> CoreResult<()> {
    validate_wall_time(&clock.wall_time_utc, &format!("{path}.wallTimeUtc"))
}

fn validate_settings(settings: &PinnedStudySettingsV1) -> CoreResult<()> {
    validate_sha256(
        &settings.portable_settings_sha256,
        "study.pinnedSettings.portableSettingsSha256",
    )?;
    if !(1..=240).contains(&settings.acquisition.sample_rate_hz) {
        return invalid(
            "study.pinnedSettings.acquisition.sampleRateHz",
            "must be within 1..=240",
        );
    }
    for (name, color) in [
        ("up", &settings.visual.palette.up),
        ("down", &settings.visual.palette.down),
        ("left", &settings.visual.palette.left),
        ("right", &settings.visual.palette.right),
    ] {
        validate_color(
            color,
            &format!("study.pinnedSettings.visual.palette.{name}"),
        )?;
    }
    validate_finite_range(
        settings.visual.animation_speed_multiplier,
        0.25,
        4.0,
        "study.pinnedSettings.visual.animationSpeedMultiplier",
    )?;
    validate_finite_range(
        settings.visual.pulse_amplitude_multiplier,
        0.0,
        3.0,
        "study.pinnedSettings.visual.pulseAmplitudeMultiplier",
    )?;
    validate_finite_range(
        settings.visual.disorder_multiplier,
        0.0,
        3.0,
        "study.pinnedSettings.visual.disorderMultiplier",
    )?;
    validate_finite_range(
        settings.visual.opacity,
        0.0,
        1.0,
        "study.pinnedSettings.visual.opacity",
    )?;
    validate_finite_range(
        settings.visual.widget_scale,
        0.5,
        2.0,
        "study.pinnedSettings.visual.widgetScale",
    )
}

fn validate_media_asset(asset: &MediaAssetV1, path: &str) -> CoreResult<()> {
    validate_id(&asset.asset_id, &format!("{path}.assetId"))?;
    validate_sha256(&asset.sha256, &format!("{path}.sha256"))?;
    if asset.byte_length == 0 || asset.byte_length > MAX_MEDIA_BYTES {
        return invalid(
            format!("{path}.byteLength"),
            format!("must be within 1..={MAX_MEDIA_BYTES}"),
        );
    }
    if asset.duration_ms == 0 || asset.duration_ms > MAX_MEDIA_DURATION_MS {
        return invalid(
            format!("{path}.durationMs"),
            format!("must be within 1..={MAX_MEDIA_DURATION_MS}"),
        );
    }
    validate_mime(&asset.mime_type, &format!("{path}.mimeType"))?;
    validate_id(&asset.container, &format!("{path}.container"))?;
    validate_unique_capabilities(
        &asset.required_capabilities,
        &format!("{path}.requiredCapabilities"),
    )?;
    if let Some(clip) = &asset.default_clip {
        validate_clip(clip, asset.duration_ms, &format!("{path}.defaultClip"))?;
    }
    Ok(())
}

fn validate_questionnaire(questionnaire: &QuestionnaireV1, path: &str) -> CoreResult<()> {
    validate_id(
        &questionnaire.questionnaire_id,
        &format!("{path}.questionnaireId"),
    )?;
    validate_text(
        &questionnaire.title,
        1,
        MAX_TITLE_CHARS,
        &format!("{path}.title"),
    )?;
    validate_text(
        &questionnaire.description,
        0,
        MAX_DESCRIPTION_CHARS,
        &format!("{path}.description"),
    )?;
    if questionnaire.items.is_empty() {
        return invalid(format!("{path}.items"), "must contain at least one item");
    }
    ensure_count(
        questionnaire.items.len(),
        MAX_ITEMS_PER_QUESTIONNAIRE,
        &format!("{path}.items"),
    )?;
    let mut item_ids = HashSet::new();
    for (index, item) in questionnaire.items.iter().enumerate() {
        let item_path = format!("{path}.items[{index}]");
        validate_id(item.item_id(), &format!("{item_path}.itemId"))?;
        insert_unique(
            &mut item_ids,
            item.item_id(),
            &format!("{item_path}.itemId"),
        )?;
        validate_questionnaire_item(item, &item_path)?;
    }
    Ok(())
}

fn validate_questionnaire_item(item: &QuestionnaireItemV1, path: &str) -> CoreResult<()> {
    let prompt = match item {
        QuestionnaireItemV1::Acknowledgement { prompt, .. }
        | QuestionnaireItemV1::SingleChoice { prompt, .. }
        | QuestionnaireItemV1::MultipleChoice { prompt, .. }
        | QuestionnaireItemV1::Likert { prompt, .. }
        | QuestionnaireItemV1::Vas { prompt, .. }
        | QuestionnaireItemV1::Numeric { prompt, .. }
        | QuestionnaireItemV1::Affect2d { prompt, .. } => prompt,
    };
    validate_text(prompt, 1, MAX_INSTRUCTION_CHARS, &format!("{path}.prompt"))?;

    match item {
        QuestionnaireItemV1::Acknowledgement { .. } => {}
        QuestionnaireItemV1::SingleChoice { options, .. } => {
            validate_options(options, path)?;
        }
        QuestionnaireItemV1::MultipleChoice {
            min_selections,
            max_selections,
            options,
            ..
        } => {
            validate_options(options, path)?;
            if min_selections > max_selections || usize::from(*max_selections) > options.len() {
                return invalid(
                    format!("{path}.maxSelections"),
                    "selection bounds must be ordered and fit the option count",
                );
            }
        }
        QuestionnaireItemV1::Likert {
            min,
            max,
            min_label,
            max_label,
            ..
        } => {
            if min >= max || (*max - *min) > 100 {
                return invalid(
                    format!("{path}.max"),
                    "must be greater than min with a span no larger than 100",
                );
            }
            validate_endpoint_labels(min_label, max_label, path)?;
        }
        QuestionnaireItemV1::Vas {
            min,
            max,
            step,
            min_label,
            max_label,
            ..
        } => {
            validate_numeric_scale(*min, *max, *step, path)?;
            validate_endpoint_labels(min_label, max_label, path)?;
        }
        QuestionnaireItemV1::Numeric {
            min,
            max,
            step,
            unit,
            ..
        } => {
            validate_numeric_scale(*min, *max, *step, path)?;
            if let Some(unit) = unit {
                validate_text(unit, 1, 32, &format!("{path}.unit"))?;
            }
        }
        QuestionnaireItemV1::Affect2d { step, .. } => {
            validate_finite_range(*step, 0.001, 2.0, &format!("{path}.step"))?;
        }
    }
    Ok(())
}

fn validate_options(options: &[ChoiceOptionV1], path: &str) -> CoreResult<()> {
    if options.len() < 2 {
        return invalid(
            format!("{path}.options"),
            "must contain at least two options",
        );
    }
    ensure_count(
        options.len(),
        MAX_OPTIONS_PER_ITEM,
        &format!("{path}.options"),
    )?;
    let mut option_ids = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        let option_path = format!("{path}.options[{index}]");
        validate_id(&option.option_id, &format!("{option_path}.optionId"))?;
        insert_unique(
            &mut option_ids,
            &option.option_id,
            &format!("{option_path}.optionId"),
        )?;
        validate_text(
            &option.label,
            1,
            MAX_LABEL_CHARS,
            &format!("{option_path}.label"),
        )?;
    }
    Ok(())
}

fn validate_block(
    block: &StudyBlockV1,
    path: &str,
    asset_ids: &HashSet<String>,
    questionnaire_ids: &HashSet<String>,
    assets: &[MediaAssetV1],
) -> CoreResult<()> {
    match block {
        StudyBlockV1::Instruction { content, .. } | StudyBlockV1::Completion { content, .. } => {
            validate_text(
                content,
                1,
                MAX_INSTRUCTION_CHARS,
                &format!("{path}.content"),
            )?;
        }
        StudyBlockV1::Break {
            content,
            minimum_duration_ms,
            ..
        } => {
            validate_text(
                content,
                1,
                MAX_INSTRUCTION_CHARS,
                &format!("{path}.content"),
            )?;
            if minimum_duration_ms.is_some_and(|duration| duration == 0 || duration > 3_600_000) {
                return invalid(
                    format!("{path}.minimumDurationMs"),
                    "must be within 1..=3600000 when present",
                );
            }
        }
        StudyBlockV1::Questionnaire {
            questionnaire_id, ..
        } => {
            validate_id(questionnaire_id, &format!("{path}.questionnaireId"))?;
            if !questionnaire_ids.contains(questionnaire_id) {
                return missing(
                    format!("{path}.questionnaireId"),
                    format!("unknown questionnaire {questionnaire_id}"),
                );
            }
        }
        StudyBlockV1::Video { source, .. } => match source {
            MediaSourceV1::ContentAsset { asset_id, clip } => {
                validate_id(asset_id, &format!("{path}.source.assetId"))?;
                if !asset_ids.contains(asset_id) {
                    return missing(
                        format!("{path}.source.assetId"),
                        format!("unknown media asset {asset_id}"),
                    );
                }
                if let Some(clip) = clip {
                    let asset = assets
                        .iter()
                        .find(|asset| asset.asset_id == *asset_id)
                        .ok_or_else(|| {
                            CoreErrorV1::new(
                                CoreErrorCodeV1::MissingReference,
                                format!("{path}.source.assetId"),
                                format!("unknown media asset {asset_id}"),
                            )
                        })?;
                    validate_clip(clip, asset.duration_ms, &format!("{path}.source.clip"))?;
                }
            }
            MediaSourceV1::Youtube {
                video_id,
                start_ms,
                end_ms,
            } => {
                if !(6..=32).contains(&video_id.len())
                    || !video_id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                {
                    return invalid(
                        format!("{path}.source.videoId"),
                        "must be a 6..=32 character YouTube identifier",
                    );
                }
                if start_ms >= end_ms || end_ms - start_ms > MAX_MEDIA_DURATION_MS {
                    return invalid(
                        format!("{path}.source.endMs"),
                        "must be after startMs and within the maximum duration",
                    );
                }
            }
        },
    }
    Ok(())
}

fn validate_answer(
    item: &QuestionnaireItemV1,
    answer: &QuestionnaireAnswerV1,
    answer_index: usize,
) -> CoreResult<()> {
    let path = format!("action.command.answers[{answer_index}]");
    match (item, answer) {
        (
            QuestionnaireItemV1::Acknowledgement { required, .. },
            QuestionnaireAnswerV1::Acknowledgement { acknowledged, .. },
        ) => {
            if *required && !acknowledged {
                return Err(CoreErrorV1::new(
                    CoreErrorCodeV1::IncompleteQuestionnaire,
                    format!("{path}.acknowledged"),
                    "a required acknowledgement must be accepted",
                ));
            }
        }
        (
            QuestionnaireItemV1::SingleChoice { options, .. },
            QuestionnaireAnswerV1::SingleChoice { option_id, .. },
        ) => {
            if !options.iter().any(|option| option.option_id == *option_id) {
                return missing(
                    format!("{path}.optionId"),
                    format!("unknown option {option_id}"),
                );
            }
        }
        (
            QuestionnaireItemV1::MultipleChoice {
                min_selections,
                max_selections,
                options,
                ..
            },
            QuestionnaireAnswerV1::MultipleChoice { option_ids, .. },
        ) => {
            let mut unique = HashSet::new();
            for option_id in option_ids {
                if !unique.insert(option_id) {
                    return duplicate(format!("{path}.optionIds"), option_id);
                }
                if !options.iter().any(|option| option.option_id == *option_id) {
                    return missing(
                        format!("{path}.optionIds"),
                        format!("unknown option {option_id}"),
                    );
                }
            }
            if option_ids.len() < usize::from(*min_selections)
                || option_ids.len() > usize::from(*max_selections)
            {
                return invalid(
                    format!("{path}.optionIds"),
                    "selection count is outside the questionnaire bounds",
                );
            }
        }
        (
            QuestionnaireItemV1::Likert { min, max, .. },
            QuestionnaireAnswerV1::Likert { value, .. },
        ) => {
            if value < min || value > max {
                return invalid(format!("{path}.value"), "is outside the Likert range");
            }
        }
        (
            QuestionnaireItemV1::Vas { min, max, step, .. },
            QuestionnaireAnswerV1::Vas { value, .. },
        )
        | (
            QuestionnaireItemV1::Numeric { min, max, step, .. },
            QuestionnaireAnswerV1::Numeric { value, .. },
        ) => {
            validate_answer_number(*value, *min, *max, *step, &format!("{path}.value"))?;
        }
        (
            QuestionnaireItemV1::Affect2d { step, .. },
            QuestionnaireAnswerV1::Affect2d {
                valence, arousal, ..
            },
        ) => {
            validate_answer_number(*valence, -1.0, 1.0, *step, &format!("{path}.valence"))?;
            validate_answer_number(*arousal, -1.0, 1.0, *step, &format!("{path}.arousal"))?;
        }
        _ => {
            return invalid(
                format!("{path}.type"),
                "answer type does not match the referenced questionnaire item",
            );
        }
    }
    Ok(())
}

fn validate_trial_condition_for_item(
    condition: &TrialRunConditionV1,
    item: &QuestionnaireItemV1,
    path: &str,
) -> CoreResult<()> {
    match (condition, item) {
        (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::Acknowledgement { acknowledged },
                ..
            },
            QuestionnaireItemV1::Acknowledgement { .. },
        ) => {
            if !acknowledged {
                return invalid(
                    format!("{path}.value.acknowledged"),
                    "must be true because a required acknowledgement cannot commit false",
                );
            }
        }
        (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::SingleChoice { option_id },
                ..
            },
            QuestionnaireItemV1::SingleChoice { options, .. },
        ) => {
            validate_id(option_id, &format!("{path}.value.optionId"))?;
            if !options.iter().any(|option| option.option_id == *option_id) {
                return missing(
                    format!("{path}.value.optionId"),
                    format!("unknown option {option_id}"),
                );
            }
        }
        (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::Likert { value },
                ..
            },
            QuestionnaireItemV1::Likert { min, max, .. },
        ) => {
            if value < min || value > max {
                return invalid(format!("{path}.value.value"), "is outside the Likert range");
            }
        }
        (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::Vas { value },
                ..
            },
            QuestionnaireItemV1::Vas { min, max, step, .. },
        )
        | (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::Numeric { value },
                ..
            },
            QuestionnaireItemV1::Numeric { min, max, step, .. },
        ) => {
            validate_answer_number(*value, *min, *max, *step, &format!("{path}.value.value"))?;
        }
        (
            TrialRunConditionV1::Equals {
                value: TrialConditionEqualityValueV1::Affect2d { valence, arousal },
                ..
            },
            QuestionnaireItemV1::Affect2d { step, .. },
        ) => {
            validate_answer_number(*valence, -1.0, 1.0, *step, &format!("{path}.value.valence"))?;
            validate_answer_number(*arousal, -1.0, 1.0, *step, &format!("{path}.value.arousal"))?;
        }
        (
            TrialRunConditionV1::Contains { option_id, .. },
            QuestionnaireItemV1::MultipleChoice { options, .. },
        ) => {
            validate_id(option_id, &format!("{path}.optionId"))?;
            if !options.iter().any(|option| option.option_id == *option_id) {
                return missing(
                    format!("{path}.optionId"),
                    format!("unknown option {option_id}"),
                );
            }
        }
        _ => {
            return invalid(
                format!("{path}.operator"),
                "operator and typed value must match the referenced questionnaire item",
            );
        }
    }
    Ok(())
}

fn validate_sample(sample: &AffectSampleV1, path: &str) -> CoreResult<()> {
    for (name, value) in [
        ("currentValence", sample.current_valence),
        ("currentArousal", sample.current_arousal),
        ("targetValence", sample.target_valence),
        ("targetArousal", sample.target_arousal),
    ] {
        validate_finite_range(value, -1.0, 1.0, &format!("{path}.{name}"))?;
    }
    Ok(())
}

fn validate_affect_point(point: &AffectPointV1, path: &str) -> CoreResult<()> {
    validate_finite_range(point.valence, -1.0, 1.0, &format!("{path}.valence"))?;
    validate_finite_range(point.arousal, -1.0, 1.0, &format!("{path}.arousal"))
}

fn validate_resolved_order(order: &ResolvedSectionOrderV1, path: &str) -> CoreResult<()> {
    validate_id(&order.section_id, &format!("{path}.sectionId"))?;
    validate_id(
        &order.algorithm_version,
        &format!("{path}.algorithmVersion"),
    )?;
    if order.trial_ids.is_empty() {
        return invalid(format!("{path}.trialIds"), "must not be empty");
    }
    let mut ids = HashSet::new();
    for (index, trial_id) in order.trial_ids.iter().enumerate() {
        validate_id(trial_id, &format!("{path}.trialIds[{index}]"))?;
        insert_unique(&mut ids, trial_id, &format!("{path}.trialIds[{index}]"))?;
    }
    if order.counterbalance_group == Some(0) {
        return invalid(
            format!("{path}.counterbalanceGroup"),
            "is one-based and must be at least 1",
        );
    }
    match order.algorithm_version.as_str() {
        crate::FIXED_ORDER_ALGORITHM_V1 | crate::SEEDED_ORDER_ALGORITHM_V1 => {
            if order.counterbalance_group.is_some() || order.matrix_sha256.is_some() {
                return invalid(
                    path,
                    "fixed and seeded orders cannot declare Williams provenance",
                );
            }
        }
        crate::WILLIAMS_ORDER_ALGORITHM_V1 => {
            let Some(matrix_sha256) = order.matrix_sha256.as_ref() else {
                return invalid(
                    path,
                    "Williams orders require a group and complete matrix digest",
                );
            };
            if order.counterbalance_group.is_none() {
                return invalid(path, "Williams orders require a one-based group");
            }
            validate_sha256(matrix_sha256, &format!("{path}.matrixSha256"))?;
        }
        _ => {
            return invalid(
                format!("{path}.algorithmVersion"),
                "is not a supported v1 ordering algorithm",
            );
        }
    }
    Ok(())
}

fn validate_clip(clip: &MediaClipV1, duration_ms: u64, path: &str) -> CoreResult<()> {
    if clip.start_ms >= clip.end_ms || clip.end_ms > duration_ms {
        return invalid(
            path,
            "startMs must be before endMs and endMs must not exceed media duration",
        );
    }
    Ok(())
}

fn validate_numeric_scale(min: f64, max: f64, step: f64, path: &str) -> CoreResult<()> {
    if !min.is_finite()
        || !max.is_finite()
        || !step.is_finite()
        || min >= max
        || step <= 0.0
        || step > max - min
        || max - min > 1_000_000.0
    {
        return invalid(
            path,
            "numeric bounds and step must be finite, ordered, positive, and bounded",
        );
    }
    Ok(())
}

fn validate_answer_number(value: f64, min: f64, max: f64, step: f64, path: &str) -> CoreResult<()> {
    if !value.is_finite() || value < min || value > max {
        return invalid(path, "is outside the finite response range");
    }
    let steps = (value - min) / step;
    if (steps - steps.round()).abs() > 1.0e-8 {
        return invalid(path, "does not align to the configured step");
    }
    Ok(())
}

fn validate_endpoint_labels(min_label: &str, max_label: &str, path: &str) -> CoreResult<()> {
    validate_text(min_label, 1, MAX_LABEL_CHARS, &format!("{path}.minLabel"))?;
    validate_text(max_label, 1, MAX_LABEL_CHARS, &format!("{path}.maxLabel"))
}

fn validate_schema(schema: &str, expected: &str, version: u16, path: &str) -> CoreResult<()> {
    if schema != expected || version != CONTRACT_VERSION_V1 {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidSchema,
            path,
            format!("expected schema {expected} version {CONTRACT_VERSION_V1}"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_sha256(hash: &Sha256HexV1, path: &str) -> CoreResult<()> {
    if hash.0.len() != 64
        || !hash
            .0
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return invalid(path, "must be exactly 64 lowercase hexadecimal characters");
    }
    Ok(())
}

fn validate_unique_capabilities(
    capabilities: &[PlatformCapabilityV1],
    path: &str,
) -> CoreResult<()> {
    let mut unique = HashSet::new();
    for capability in capabilities {
        if !unique.insert(*capability) {
            return duplicate(path, format!("{capability:?}"));
        }
    }
    Ok(())
}

pub(crate) fn validate_id(value: &str, path: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        return invalid(
            path,
            format!(
                "must be 1..={MAX_ID_BYTES} ASCII bytes using letters, digits, '.', '_', or '-' and start alphanumeric"
            ),
        );
    }
    Ok(())
}

fn validate_mime(value: &str, path: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value.is_ascii()
        || value.chars().any(char::is_whitespace)
        || value.matches('/').count() != 1
    {
        return invalid(path, "must be a bounded ASCII MIME type");
    }
    Ok(())
}

fn validate_color(value: &str, path: &str) -> CoreResult<()> {
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return invalid(path, "must use #RRGGBB hexadecimal notation");
    }
    Ok(())
}

fn validate_text(
    value: &str,
    minimum_chars: usize,
    maximum_chars: usize,
    path: &str,
) -> CoreResult<()> {
    let count = value.chars().count();
    if count < minimum_chars || count > maximum_chars || value.contains('\0') {
        return invalid(
            path,
            format!("must contain {minimum_chars}..={maximum_chars} characters and no NUL"),
        );
    }
    if minimum_chars > 0 && value.trim().is_empty() {
        return invalid(path, "must not contain only whitespace");
    }
    Ok(())
}

fn validate_wall_time(value: &str, path: &str) -> CoreResult<()> {
    if !(20..=35).contains(&value.len())
        || !value.is_ascii()
        || !value.ends_with('Z')
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
    {
        return invalid(path, "must be a bounded UTC RFC 3339 timestamp ending in Z");
    }
    Ok(())
}

fn validate_finite_range(value: f64, minimum: f64, maximum: f64, path: &str) -> CoreResult<()> {
    if !value.is_finite() || value < minimum || value > maximum {
        return invalid(
            path,
            format!("must be finite and within {minimum}..={maximum}"),
        );
    }
    Ok(())
}

fn insert_unique(values: &mut HashSet<String>, value: &str, path: &str) -> CoreResult<()> {
    if !values.insert(value.to_owned()) {
        return duplicate(path, value);
    }
    Ok(())
}

fn ensure_count(count: usize, maximum: usize, path: &str) -> CoreResult<()> {
    if count > maximum {
        return limit(path, maximum);
    }
    Ok(())
}

fn invalid<T>(path: impl Into<String>, message: impl Into<String>) -> CoreResult<T> {
    Err(CoreErrorV1::new(
        CoreErrorCodeV1::InvalidValue,
        path,
        message,
    ))
}

fn missing<T>(path: impl Into<String>, message: impl Into<String>) -> CoreResult<T> {
    Err(CoreErrorV1::new(
        CoreErrorCodeV1::MissingReference,
        path,
        message,
    ))
}

fn duplicate<T>(path: impl Into<String>, value: impl std::fmt::Display) -> CoreResult<T> {
    Err(CoreErrorV1::new(
        CoreErrorCodeV1::DuplicateId,
        path,
        format!("duplicate value {value}"),
    ))
}

fn limit<T>(path: impl Into<String>, maximum: usize) -> CoreResult<T> {
    Err(CoreErrorV1::new(
        CoreErrorCodeV1::LimitExceeded,
        path,
        format!("must contain no more than {maximum} entries"),
    ))
}
