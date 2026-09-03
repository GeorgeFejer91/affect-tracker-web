use crate::validation::{validate_health, validate_media_anchor, validate_questionnaire_answers};
use crate::{
    resolve_study_order, AffectCalibrationV1, AffectPointV1, AffectResetPolicyV1,
    CalibrationMethodV1, CompletionStatusV1, CoreErrorCodeV1, CoreErrorV1, CoreResult,
    EventClockV1, HealthStatusV1, MediaClipV1, MediaSourceV1, ReducerOutcomeV1, RunEventPayloadV1,
    RunEventV1, RunPhaseV1, RunStateV1, StudyActionV1, StudyBlockV1, StudyCommandV1,
    StudyDefinitionV1, CONTRACT_VERSION_V1, RUN_EVENT_SCHEMA_V1, RUN_STATE_SCHEMA_V1,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy)]
struct BlockCursorV1 {
    section_index: usize,
    trial_index: usize,
    block_index: usize,
}

/// Sole platform-neutral authority for a single immutable study/run pair.
///
/// Callers serialize all access. Every accepted action advances the state
/// revision exactly once and returns newly allocated immutable events for the
/// adapter to journal. Failed actions leave authority state unchanged.
#[derive(Debug, Clone)]
pub struct StudyAuthorityV1 {
    study: StudyDefinitionV1,
    configuration: crate::RunConfigurationV1,
    state: RunStateV1,
    cursors: Vec<BlockCursorV1>,
    current_cursor: Option<usize>,
    committed_answers: BTreeMap<(String, String), crate::QuestionnaireAnswerV1>,
}

impl StudyAuthorityV1 {
    pub fn new(
        study: StudyDefinitionV1,
        configuration: crate::RunConfigurationV1,
        authority_generation: u64,
    ) -> CoreResult<Self> {
        study.validate_published()?;
        configuration.validate_for(&study)?;
        if authority_generation == 0 {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::InvalidValue,
                "authorityGeneration",
                "must be at least 1",
            ));
        }
        let protocol_hash = study.protocol_hash.clone().ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::InvalidSchema,
                "study.protocolHash",
                "published study is missing its protocol hash",
            )
        })?;
        let state = RunStateV1 {
            schema: RUN_STATE_SCHEMA_V1.to_owned(),
            version: CONTRACT_VERSION_V1,
            authority_generation,
            revision: 0,
            run_id: configuration.run_id.clone(),
            protocol_hash,
            phase: RunPhaseV1::Created,
            current_section_id: None,
            current_trial_id: None,
            current_block_id: None,
            resolved_order: Vec::new(),
            media_timeline_anchor: None,
            stall: None,
            health: configuration.initial_health.clone(),
            applied_settings_sha256: None,
            affect_calibration: None,
            completed_questionnaire_blocks: Vec::new(),
            completion_status: None,
            last_event_sequence: 0,
            last_event_monotonic_ms: 0,
        };
        Ok(Self {
            study,
            configuration,
            state,
            cursors: Vec::new(),
            current_cursor: None,
            committed_answers: BTreeMap::new(),
        })
    }

    #[must_use]
    pub fn study(&self) -> &StudyDefinitionV1 {
        &self.study
    }

    #[must_use]
    pub fn configuration(&self) -> &crate::RunConfigurationV1 {
        &self.configuration
    }

    #[must_use]
    pub fn state(&self) -> &RunStateV1 {
        &self.state
    }

    #[must_use]
    pub fn current_block(&self) -> Option<&StudyBlockV1> {
        self.current_cursor
            .and_then(|index| self.cursors.get(index))
            .and_then(|cursor| block_at(&self.study, *cursor))
    }

    pub fn apply(&mut self, action: StudyActionV1) -> CoreResult<ReducerOutcomeV1> {
        self.validate_action_preconditions(&action)?;
        let next_revision = self.state.revision.checked_add(1).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::LimitExceeded,
                "state.revision",
                "revision exhausted",
            )
        })?;

        let mut next_state = self.state.clone();
        next_state.revision = next_revision;
        let mut next_cursors = self.cursors.clone();
        let mut next_cursor = self.current_cursor;
        let mut next_committed_answers = self.committed_answers.clone();
        let mut events = Vec::new();

        match &action.command {
            StudyCommandV1::Prepare => {
                require_phase(&next_state, &[RunPhaseV1::Created], "prepare")?;
                let resolved_order = resolve_study_order(&self.study, &self.configuration)?;
                next_cursors = flatten_cursors(&self.study, &resolved_order)?;
                next_cursor = Some(0);
                next_state.resolved_order = resolved_order;
                next_state.phase = RunPhaseV1::Prepared;
                set_current_from_cursor(&mut next_state, &self.study, &next_cursors, next_cursor)?;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::Prepared,
                    &mut events,
                )?;
                if self.study.pinned_settings.acquisition.reset_policy
                    == AffectResetPolicyV1::NeutralAtRunStart
                {
                    let calibration = neutral_calibration();
                    next_state.affect_calibration = Some(calibration.clone());
                    append_event(
                        &mut next_state,
                        &action,
                        RunEventPayloadV1::AffectReset { calibration },
                        &mut events,
                    )?;
                }
            }
            StudyCommandV1::ApplyPinnedSettings { settings_sha256 } => {
                require_phase(&next_state, &[RunPhaseV1::Prepared], "applyPinnedSettings")?;
                if settings_sha256 != &self.study.pinned_settings.portable_settings_sha256 {
                    return Err(CoreErrorV1::new(
                        CoreErrorCodeV1::HashMismatch,
                        "action.command.settingsSha256",
                        "does not match the published study settings",
                    ));
                }
                next_state.applied_settings_sha256 = Some(settings_sha256.clone());
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::SettingsApplied {
                        settings_sha256: settings_sha256.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::SetAffectCalibration { point } => {
                require_phase(&next_state, &[RunPhaseV1::Prepared], "setAffectCalibration")?;
                let calibration = AffectCalibrationV1 {
                    point: *point,
                    method: CalibrationMethodV1::ResearcherCalibration,
                };
                next_state.affect_calibration = Some(calibration.clone());
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::AffectCalibrationSet { calibration },
                    &mut events,
                )?;
            }
            StudyCommandV1::ResetAffect => {
                require_phase(&next_state, &[RunPhaseV1::Prepared], "resetAffect")?;
                let calibration = neutral_calibration();
                next_state.affect_calibration = Some(calibration.clone());
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::AffectReset { calibration },
                    &mut events,
                )?;
            }
            StudyCommandV1::Arm => {
                require_phase(&next_state, &[RunPhaseV1::Prepared], "arm")?;
                require_arm_readiness(&next_state, &self.configuration)?;
                next_state.phase = RunPhaseV1::Armed;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::Armed,
                    &mut events,
                )?;
            }
            StudyCommandV1::Start => {
                require_phase(&next_state, &[RunPhaseV1::Armed], "start")?;
                if next_cursor.is_none() {
                    return transition("start", "prepared run has no current block");
                }
                next_state.phase = RunPhaseV1::Running;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunStarted,
                    &mut events,
                )?;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::BlockEntered,
                    &mut events,
                )?;
            }
            StudyCommandV1::Pause { reason_code } => {
                require_phase(&next_state, &[RunPhaseV1::Running], "pause")?;
                next_state.phase = RunPhaseV1::Paused;
                if let Some(anchor) = &mut next_state.media_timeline_anchor {
                    anchor.playing = false;
                    anchor.observed_monotonic_ms = action.clock.monotonic_ms;
                }
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunPaused {
                        reason_code: reason_code.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::Resume => {
                require_phase(&next_state, &[RunPhaseV1::Paused], "resume")?;
                next_state.phase = RunPhaseV1::Running;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunResumed,
                    &mut events,
                )?;
            }
            StudyCommandV1::Advance => {
                require_phase(&next_state, &[RunPhaseV1::Running], "advance")?;
                require_current_questionnaire_complete(
                    &next_state,
                    &self.study,
                    &next_cursors,
                    next_cursor,
                )?;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::BlockCompleted,
                    &mut events,
                )?;
                let following = next_cursor
                    .and_then(|index| index.checked_add(1))
                    .filter(|index| *index < next_cursors.len());
                next_state.media_timeline_anchor = None;
                next_state.stall = None;
                next_cursor = next_eligible_cursor(
                    following,
                    &self.study,
                    &next_cursors,
                    &next_committed_answers,
                    &mut next_state,
                    &action,
                    &mut events,
                )?;
                if next_cursor.is_some() {
                    set_current_from_cursor(
                        &mut next_state,
                        &self.study,
                        &next_cursors,
                        next_cursor,
                    )?;
                    append_event(
                        &mut next_state,
                        &action,
                        RunEventPayloadV1::BlockEntered,
                        &mut events,
                    )?;
                } else {
                    clear_current(&mut next_state);
                    next_state.phase = RunPhaseV1::AwaitingFinalization;
                    append_event(
                        &mut next_state,
                        &action,
                        RunEventPayloadV1::RunReadyToFinalize,
                        &mut events,
                    )?;
                }
            }
            StudyCommandV1::RetryBlock { reason_code } => {
                require_phase(
                    &next_state,
                    &[RunPhaseV1::Running, RunPhaseV1::Paused],
                    "retryBlock",
                )?;
                require_current_block(&self.study, &next_cursors, next_cursor)?;
                if let Some(block_id) = &next_state.current_block_id {
                    next_state
                        .completed_questionnaire_blocks
                        .retain(|completed| completed != block_id);
                    next_committed_answers.retain(|(questionnaire_block_id, _), _| {
                        questionnaire_block_id != block_id
                    });
                }
                next_state.media_timeline_anchor = None;
                next_state.stall = None;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::BlockRetried {
                        reason_code: reason_code.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::SubmitQuestionnaire {
                questionnaire_id,
                answers,
            } => {
                require_phase(&next_state, &[RunPhaseV1::Running], "submitQuestionnaire")?;
                let block = require_current_block(&self.study, &next_cursors, next_cursor)?;
                let expected_questionnaire = match block {
                    StudyBlockV1::Questionnaire {
                        questionnaire_id, ..
                    } => questionnaire_id,
                    _ => {
                        return transition(
                            "submitQuestionnaire",
                            "current block is not a questionnaire",
                        );
                    }
                };
                if questionnaire_id != expected_questionnaire {
                    return Err(CoreErrorV1::new(
                        CoreErrorCodeV1::RunMismatch,
                        "action.command.questionnaireId",
                        "does not match the current questionnaire block",
                    ));
                }
                let block_id = next_state.current_block_id.clone().ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::InvalidTransition,
                        "state.currentBlockId",
                        "questionnaire block has no current block identifier",
                    )
                })?;
                if next_state
                    .completed_questionnaire_blocks
                    .contains(&block_id)
                {
                    return transition(
                        "submitQuestionnaire",
                        "current questionnaire was already committed",
                    );
                }
                let questionnaire =
                    self.study.questionnaire(questionnaire_id).ok_or_else(|| {
                        CoreErrorV1::new(
                            CoreErrorCodeV1::MissingReference,
                            "action.command.questionnaireId",
                            "referenced questionnaire is unavailable",
                        )
                    })?;
                validate_questionnaire_answers(questionnaire, answers)?;
                for answer in answers {
                    next_committed_answers.insert(
                        (block_id.clone(), answer.item_id().to_owned()),
                        answer.clone(),
                    );
                }
                next_state.completed_questionnaire_blocks.push(block_id);
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::QuestionnaireSubmitted {
                        questionnaire_id: questionnaire_id.clone(),
                        answers: answers.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::RecordAffectSample { sample } => {
                require_phase(&next_state, &[RunPhaseV1::Running], "recordAffectSample")?;
                let block = require_current_block(&self.study, &next_cursors, next_cursor)?;
                if !matches!(
                    block,
                    StudyBlockV1::Video {
                        collect_affect: true,
                        ..
                    }
                ) {
                    return transition(
                        "recordAffectSample",
                        "current block is not configured for affect collection",
                    );
                }
                if !next_state
                    .media_timeline_anchor
                    .as_ref()
                    .is_some_and(|anchor| anchor.playing)
                {
                    return transition(
                        "recordAffectSample",
                        "media playback must be active before collecting a sample",
                    );
                }
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::AffectSampleRecorded { sample: *sample },
                    &mut events,
                )?;
            }
            StudyCommandV1::ReportMediaTimeline { anchor } => {
                require_phase(
                    &next_state,
                    &[RunPhaseV1::Running, RunPhaseV1::Paused],
                    "reportMediaTimeline",
                )?;
                let block = require_current_block(&self.study, &next_cursors, next_cursor)?;
                let source = match block {
                    StudyBlockV1::Video { source, .. } => source,
                    _ => {
                        return transition("reportMediaTimeline", "current block is not a video");
                    }
                };
                validate_timeline_for_source(
                    anchor,
                    source,
                    &self.study,
                    &next_state,
                    &action.clock,
                )?;
                next_state.media_timeline_anchor = Some(anchor.clone());
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::MediaTimelineUpdated {
                        anchor: anchor.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::ReportHealth { health } => {
                require_phase(
                    &next_state,
                    &[
                        RunPhaseV1::Created,
                        RunPhaseV1::Prepared,
                        RunPhaseV1::Armed,
                        RunPhaseV1::Running,
                        RunPhaseV1::Paused,
                    ],
                    "reportHealth",
                )?;
                validate_health(health, "action.command.health")?;
                next_state.health = health.clone();
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::HealthUpdated {
                        health: health.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::ReportStall { stall } => {
                require_phase(
                    &next_state,
                    &[RunPhaseV1::Running, RunPhaseV1::Paused],
                    "reportStall",
                )?;
                next_state.stall = Some(stall.clone());
                if let Some(anchor) = &mut next_state.media_timeline_anchor {
                    anchor.playing = false;
                    anchor.observed_monotonic_ms = action.clock.monotonic_ms;
                }
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::StallReported {
                        stall: stall.clone(),
                    },
                    &mut events,
                )?;
            }
            StudyCommandV1::ClearStall => {
                require_phase(
                    &next_state,
                    &[RunPhaseV1::Running, RunPhaseV1::Paused],
                    "clearStall",
                )?;
                if next_state.stall.is_none() {
                    return transition("clearStall", "run is not stalled");
                }
                next_state.stall = None;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::StallCleared,
                    &mut events,
                )?;
            }
            StudyCommandV1::Stop { reason_code } => {
                require_phase(
                    &next_state,
                    &[RunPhaseV1::Running, RunPhaseV1::Paused],
                    "stop",
                )?;
                if !self.study.completion_policy.allow_early_stop {
                    return transition("stop", "published completion policy forbids early stop");
                }
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunStopped {
                        reason_code: reason_code.clone(),
                    },
                    &mut events,
                )?;
                next_state.phase = RunPhaseV1::Completed;
                next_state.completion_status = Some(CompletionStatusV1::StoppedEarly);
                next_state.media_timeline_anchor = None;
                next_state.stall = None;
                next_cursor = None;
                clear_current(&mut next_state);
            }
            StudyCommandV1::Finalize => {
                require_phase(&next_state, &[RunPhaseV1::AwaitingFinalization], "finalize")?;
                next_state.phase = RunPhaseV1::Completed;
                next_state.completion_status = Some(CompletionStatusV1::Completed);
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunFinalized,
                    &mut events,
                )?;
            }
            StudyCommandV1::Abort { reason_code } => {
                require_phase(
                    &next_state,
                    &[
                        RunPhaseV1::Created,
                        RunPhaseV1::Prepared,
                        RunPhaseV1::Armed,
                        RunPhaseV1::Running,
                        RunPhaseV1::Paused,
                        RunPhaseV1::AwaitingFinalization,
                    ],
                    "abort",
                )?;
                append_event(
                    &mut next_state,
                    &action,
                    RunEventPayloadV1::RunAborted {
                        reason_code: reason_code.clone(),
                    },
                    &mut events,
                )?;
                next_state.phase = RunPhaseV1::Aborted;
                next_state.completion_status = Some(CompletionStatusV1::Aborted);
                next_state.media_timeline_anchor = None;
                next_state.stall = None;
                next_cursor = None;
                clear_current(&mut next_state);
            }
        }

        self.state = next_state;
        self.cursors = next_cursors;
        self.current_cursor = next_cursor;
        self.committed_answers = next_committed_answers;
        Ok(ReducerOutcomeV1 {
            state: self.state.clone(),
            events,
        })
    }

    fn validate_action_preconditions(&self, action: &StudyActionV1) -> CoreResult<()> {
        action.validate_shape()?;
        if action.run_id != self.state.run_id {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::RunMismatch,
                "action.runId",
                "does not match the authority run",
            ));
        }
        if action.authority_generation != self.state.authority_generation {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::StaleGeneration,
                "action.authorityGeneration",
                "does not match the active authority generation",
            ));
        }
        if action.expected_revision != self.state.revision {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::StaleRevision,
                "action.expectedRevision",
                format!("expected current revision {}", self.state.revision),
            ));
        }
        if action.precondition.expected_phase != self.state.phase {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::PhasePreconditionFailed,
                "action.precondition.expectedPhase",
                format!("current phase is {:?}", self.state.phase),
            ));
        }
        if action.precondition.expected_block_id != self.state.current_block_id {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::BlockPreconditionFailed,
                "action.precondition.expectedBlockId",
                format!("current block is {:?}", self.state.current_block_id),
            ));
        }
        if action.clock.monotonic_ms < self.state.last_event_monotonic_ms {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::TimeRegression,
                "action.clock.monotonicMs",
                format!("must be at least {}", self.state.last_event_monotonic_ms),
            ));
        }
        Ok(())
    }
}

fn flatten_cursors(
    study: &StudyDefinitionV1,
    resolved_order: &[crate::ResolvedSectionOrderV1],
) -> CoreResult<Vec<BlockCursorV1>> {
    let mut cursors = Vec::new();
    for (section_index, resolved) in resolved_order.iter().enumerate() {
        let section = study.sections.get(section_index).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::MissingReference,
                "resolvedOrder",
                "resolved section does not exist",
            )
        })?;
        if section.section_id != resolved.section_id {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::RunMismatch,
                "resolvedOrder.sectionId",
                "resolved section identity does not match authored order",
            ));
        }
        for trial_id in &resolved.trial_ids {
            let trial_index = section
                .trials
                .iter()
                .position(|trial| &trial.trial_id == trial_id)
                .ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::MissingReference,
                        "resolvedOrder.trialIds",
                        format!("resolved trial {trial_id} does not exist"),
                    )
                })?;
            for block_index in 0..section.trials[trial_index].blocks.len() {
                cursors.push(BlockCursorV1 {
                    section_index,
                    trial_index,
                    block_index,
                });
            }
        }
    }
    if cursors.is_empty() {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidValue,
            "study.sections",
            "resolved study contains no blocks",
        ));
    }
    Ok(cursors)
}

fn next_eligible_cursor(
    mut candidate: Option<usize>,
    study: &StudyDefinitionV1,
    cursors: &[BlockCursorV1],
    committed_answers: &BTreeMap<(String, String), crate::QuestionnaireAnswerV1>,
    state: &mut RunStateV1,
    action: &StudyActionV1,
    events: &mut Vec<RunEventV1>,
) -> CoreResult<Option<usize>> {
    while let Some(candidate_index) = candidate {
        let cursor = *cursors.get(candidate_index).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::MissingReference,
                "state.currentBlockId",
                "candidate block cursor does not exist",
            )
        })?;
        if cursor.block_index != 0 {
            return Ok(Some(candidate_index));
        }
        let section = study.sections.get(cursor.section_index).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::MissingReference,
                "state.currentSectionId",
                "candidate section does not exist",
            )
        })?;
        let trial = section.trials.get(cursor.trial_index).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::MissingReference,
                "state.currentTrialId",
                "candidate trial does not exist",
            )
        })?;
        let Some(condition) = &trial.run_if else {
            return Ok(Some(candidate_index));
        };
        let answer_key = (
            condition.questionnaire_block_id().to_owned(),
            condition.item_id().to_owned(),
        );
        let observed_answer = committed_answers.get(&answer_key).ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::InvalidTransition,
                "state.committedAnswers",
                format!(
                    "required branch source {} / {} has not been committed",
                    condition.questionnaire_block_id(),
                    condition.item_id()
                ),
            )
        })?;
        let eligible = evaluate_trial_condition(condition, observed_answer)?;
        append_event_with_identity(
            state,
            action,
            crate::RunEventPayloadV1::TrialBranchDecided {
                condition: condition.clone(),
                observed_answer: observed_answer.clone(),
                eligible,
            },
            events,
            Some(section.section_id.clone()),
            Some(trial.trial_id.clone()),
            None,
        )?;
        if eligible {
            return Ok(Some(candidate_index));
        }
        append_event_with_identity(
            state,
            action,
            crate::RunEventPayloadV1::TrialSkipped {
                reason: crate::TrialSkipReasonV1::RunIfFalse,
            },
            events,
            Some(section.section_id.clone()),
            Some(trial.trial_id.clone()),
            None,
        )?;

        let mut following_index = candidate_index + 1;
        while cursors.get(following_index).is_some_and(|following| {
            following.section_index == cursor.section_index
                && following.trial_index == cursor.trial_index
        }) {
            following_index += 1;
        }
        candidate = (following_index < cursors.len()).then_some(following_index);
    }
    Ok(None)
}

fn evaluate_trial_condition(
    condition: &crate::TrialRunConditionV1,
    observed_answer: &crate::QuestionnaireAnswerV1,
) -> CoreResult<bool> {
    let result = match (condition, observed_answer) {
        (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::Acknowledgement { acknowledged },
                ..
            },
            crate::QuestionnaireAnswerV1::Acknowledgement {
                acknowledged: observed,
                ..
            },
        ) => acknowledged == observed,
        (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::SingleChoice { option_id },
                ..
            },
            crate::QuestionnaireAnswerV1::SingleChoice {
                option_id: observed,
                ..
            },
        ) => option_id == observed,
        (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::Likert { value },
                ..
            },
            crate::QuestionnaireAnswerV1::Likert {
                value: observed, ..
            },
        ) => value == observed,
        (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::Vas { value },
                ..
            },
            crate::QuestionnaireAnswerV1::Vas {
                value: observed, ..
            },
        )
        | (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::Numeric { value },
                ..
            },
            crate::QuestionnaireAnswerV1::Numeric {
                value: observed, ..
            },
        ) => value == observed,
        (
            crate::TrialRunConditionV1::Equals {
                value: crate::TrialConditionEqualityValueV1::Affect2d { valence, arousal },
                ..
            },
            crate::QuestionnaireAnswerV1::Affect2d {
                valence: observed_valence,
                arousal: observed_arousal,
                ..
            },
        ) => valence == observed_valence && arousal == observed_arousal,
        (
            crate::TrialRunConditionV1::Contains { option_id, .. },
            crate::QuestionnaireAnswerV1::MultipleChoice { option_ids, .. },
        ) => option_ids.contains(option_id),
        _ => {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::InvalidSchema,
                "study.trial.runIf",
                "condition type no longer matches its committed source answer",
            ));
        }
    };
    Ok(result)
}

fn block_at(study: &StudyDefinitionV1, cursor: BlockCursorV1) -> Option<&StudyBlockV1> {
    study
        .sections
        .get(cursor.section_index)
        .and_then(|section| section.trials.get(cursor.trial_index))
        .and_then(|trial| trial.blocks.get(cursor.block_index))
}

fn require_current_block<'a>(
    study: &'a StudyDefinitionV1,
    cursors: &[BlockCursorV1],
    current_cursor: Option<usize>,
) -> CoreResult<&'a StudyBlockV1> {
    current_cursor
        .and_then(|index| cursors.get(index))
        .and_then(|cursor| block_at(study, *cursor))
        .ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::InvalidTransition,
                "state.currentBlockId",
                "run has no current block",
            )
        })
}

fn set_current_from_cursor(
    state: &mut RunStateV1,
    study: &StudyDefinitionV1,
    cursors: &[BlockCursorV1],
    current_cursor: Option<usize>,
) -> CoreResult<()> {
    let cursor = current_cursor
        .and_then(|index| cursors.get(index))
        .ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::InvalidTransition,
                "state.currentBlockId",
                "run has no current block cursor",
            )
        })?;
    let section = study.sections.get(cursor.section_index).ok_or_else(|| {
        CoreErrorV1::new(
            CoreErrorCodeV1::MissingReference,
            "state.currentSectionId",
            "current section does not exist",
        )
    })?;
    let trial = section.trials.get(cursor.trial_index).ok_or_else(|| {
        CoreErrorV1::new(
            CoreErrorCodeV1::MissingReference,
            "state.currentTrialId",
            "current trial does not exist",
        )
    })?;
    let block = trial.blocks.get(cursor.block_index).ok_or_else(|| {
        CoreErrorV1::new(
            CoreErrorCodeV1::MissingReference,
            "state.currentBlockId",
            "current block does not exist",
        )
    })?;
    state.current_section_id = Some(section.section_id.clone());
    state.current_trial_id = Some(trial.trial_id.clone());
    state.current_block_id = Some(block.block_id().to_owned());
    Ok(())
}

fn clear_current(state: &mut RunStateV1) {
    state.current_section_id = None;
    state.current_trial_id = None;
    state.current_block_id = None;
}

fn append_event(
    state: &mut RunStateV1,
    action: &StudyActionV1,
    payload: RunEventPayloadV1,
    events: &mut Vec<RunEventV1>,
) -> CoreResult<()> {
    let section_id = state.current_section_id.clone();
    let trial_id = state.current_trial_id.clone();
    let block_id = state.current_block_id.clone();
    append_event_with_identity(
        state, action, payload, events, section_id, trial_id, block_id,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_event_with_identity(
    state: &mut RunStateV1,
    action: &StudyActionV1,
    payload: RunEventPayloadV1,
    events: &mut Vec<RunEventV1>,
    section_id: Option<String>,
    trial_id: Option<String>,
    block_id: Option<String>,
) -> CoreResult<()> {
    let sequence = state.last_event_sequence.checked_add(1).ok_or_else(|| {
        CoreErrorV1::new(
            CoreErrorCodeV1::LimitExceeded,
            "state.lastEventSequence",
            "event sequence exhausted",
        )
    })?;
    events.push(RunEventV1 {
        schema: RUN_EVENT_SCHEMA_V1.to_owned(),
        version: CONTRACT_VERSION_V1,
        sequence,
        authority_generation: state.authority_generation,
        revision: state.revision,
        action_id: action.action_id.clone(),
        run_id: state.run_id.clone(),
        section_id,
        trial_id,
        block_id,
        monotonic_ms: action.clock.monotonic_ms,
        wall_time_utc: action.clock.wall_time_utc.clone(),
        payload,
    });
    state.last_event_sequence = sequence;
    state.last_event_monotonic_ms = action.clock.monotonic_ms;
    Ok(())
}

fn require_phase(state: &RunStateV1, allowed: &[RunPhaseV1], command: &str) -> CoreResult<()> {
    if !allowed.contains(&state.phase) {
        return transition(
            command,
            format!("is not valid while phase is {:?}", state.phase),
        );
    }
    Ok(())
}

fn require_arm_readiness(
    state: &RunStateV1,
    configuration: &crate::RunConfigurationV1,
) -> CoreResult<()> {
    if state.applied_settings_sha256.is_none() {
        return transition("arm", "published settings have not been applied");
    }
    if state.affect_calibration.is_none() {
        return transition("arm", "pre-run affect reset/calibration is incomplete");
    }
    if state.health.storage.status != HealthStatusV1::Ready {
        return transition("arm", "storage health is not ready");
    }
    if state.health.input.status != HealthStatusV1::Ready {
        return transition("arm", "input health is not ready");
    }
    if configuration
        .platform
        .capabilities
        .contains(&crate::PlatformCapabilityV1::Lsl)
        && state.health.lsl.status != HealthStatusV1::Ready
    {
        return transition("arm", "LSL is required but its health is not ready");
    }
    Ok(())
}

fn require_current_questionnaire_complete(
    state: &RunStateV1,
    study: &StudyDefinitionV1,
    cursors: &[BlockCursorV1],
    current_cursor: Option<usize>,
) -> CoreResult<()> {
    let block = require_current_block(study, cursors, current_cursor)?;
    if matches!(block, StudyBlockV1::Questionnaire { .. }) {
        let block_id = state.current_block_id.as_ref().ok_or_else(|| {
            CoreErrorV1::new(
                CoreErrorCodeV1::InvalidTransition,
                "state.currentBlockId",
                "questionnaire block has no current identifier",
            )
        })?;
        if !state.completed_questionnaire_blocks.contains(block_id) {
            return Err(CoreErrorV1::new(
                CoreErrorCodeV1::IncompleteQuestionnaire,
                "state.currentBlockId",
                "current questionnaire must be committed before advancing",
            ));
        }
    }
    Ok(())
}

fn validate_timeline_for_source(
    anchor: &crate::MediaTimelineAnchorV1,
    source: &MediaSourceV1,
    study: &StudyDefinitionV1,
    state: &RunStateV1,
    clock: &EventClockV1,
) -> CoreResult<()> {
    validate_media_anchor(anchor, "action.command.anchor")?;
    if anchor.observed_monotonic_ms != clock.monotonic_ms {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidValue,
            "action.command.anchor.observedMonotonicMs",
            "must equal the action clock monotonicMs",
        ));
    }
    if state.phase == RunPhaseV1::Paused && anchor.playing {
        return transition(
            "reportMediaTimeline",
            "paused runs cannot report playing media",
        );
    }
    let duration = match source {
        MediaSourceV1::ContentAsset { asset_id, clip } => {
            let asset = study.media_asset(asset_id).ok_or_else(|| {
                CoreErrorV1::new(
                    CoreErrorCodeV1::MissingReference,
                    "action.command.anchor",
                    "current media asset is unavailable",
                )
            })?;
            clip.as_ref()
                .or(asset.default_clip.as_ref())
                .map_or(asset.duration_ms, clip_duration)
        }
        MediaSourceV1::Youtube {
            start_ms, end_ms, ..
        } => end_ms - start_ms,
    };
    if anchor.media_position_ms > duration {
        return Err(CoreErrorV1::new(
            CoreErrorCodeV1::InvalidValue,
            "action.command.anchor.mediaPositionMs",
            format!("must not exceed the selected segment duration {duration}"),
        ));
    }
    Ok(())
}

fn clip_duration(clip: &MediaClipV1) -> u64 {
    clip.end_ms - clip.start_ms
}

fn neutral_calibration() -> AffectCalibrationV1 {
    AffectCalibrationV1 {
        point: AffectPointV1 {
            valence: 0.0,
            arousal: 0.0,
        },
        method: CalibrationMethodV1::NeutralReset,
    }
}

fn transition<T>(command: &str, message: impl Into<String>) -> CoreResult<T> {
    Err(CoreErrorV1::new(
        CoreErrorCodeV1::InvalidTransition,
        format!("action.command.{command}"),
        message,
    ))
}
