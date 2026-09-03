mod support;

use affect_tracker_study_core::*;
use support::{action, apply, authority, complete_answers, prepare_and_start};

fn sample() -> AffectSampleV1 {
    AffectSampleV1 {
        current_valence: 0.25,
        current_arousal: -0.5,
        target_valence: 0.3,
        target_arousal: -0.4,
    }
}

fn answers_with_handedness(option: &str) -> Vec<QuestionnaireAnswerV1> {
    let mut answers = complete_answers();
    let answer = answers
        .iter_mut()
        .find(|answer| answer.item_id() == "handedness")
        .unwrap();
    *answer = QuestionnaireAnswerV1::SingleChoice {
        item_id: "handedness".to_owned(),
        option_id: option.to_owned(),
    };
    answers
}

fn reach_conditional_trial(
    authority: &mut StudyAuthorityV1,
    answers: Vec<QuestionnaireAnswerV1>,
) -> ReducerOutcomeV1 {
    prepare_and_start(authority);
    apply(authority, "branch-a1", 5, StudyCommandV1::Advance);
    apply(authority, "branch-a2", 6, StudyCommandV1::Advance);
    apply(
        authority,
        "branch-questionnaire",
        7,
        StudyCommandV1::SubmitQuestionnaire {
            questionnaire_id: "preflight".to_owned(),
            answers,
        },
    );
    let public_state = serde_json::to_value(authority.state()).unwrap();
    assert!(public_state.get("committedAnswers").is_none());
    assert!(public_state.get("answers").is_none());
    apply(authority, "branch-a3", 8, StudyCommandV1::Advance);
    apply(authority, "branch-a4", 9, StudyCommandV1::Advance);
    apply(authority, "branch-a5", 10, StudyCommandV1::Advance);
    assert_eq!(
        authority.state().current_block_id.as_deref(),
        Some("stim-b-video")
    );
    apply(authority, "branch-decision", 11, StudyCommandV1::Advance)
}

#[test]
fn lifecycle_is_revisioned_and_events_are_one_based_and_immutable() {
    let mut authority = authority();
    let events = prepare_and_start(&mut authority);

    assert_eq!(authority.state().revision, 4);
    assert_eq!(authority.state().phase, RunPhaseV1::Running);
    assert_eq!(
        authority.state().current_block_id.as_deref(),
        Some("intro-comparison")
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=6).collect::<Vec<_>>()
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.revision)
            .collect::<Vec<_>>(),
        vec![1, 1, 2, 3, 4, 4]
    );
    assert!(matches!(events[0].payload, RunEventPayloadV1::Prepared));
    assert!(matches!(
        events[1].payload,
        RunEventPayloadV1::AffectReset { .. }
    ));
    assert!(matches!(events[5].payload, RunEventPayloadV1::BlockEntered));
    assert_eq!(events[5].block_id.as_deref(), Some("intro-comparison"));
    assert_eq!(authority.state().last_event_sequence, 6);
}

#[test]
fn stale_or_mismatched_actions_fail_without_mutating_authority() {
    let mut authority = authority();
    prepare_and_start(&mut authority);
    let original = authority.state().clone();

    let mut stale_revision = action(&authority, "stale-revision", 5, StudyCommandV1::Advance);
    stale_revision.expected_revision -= 1;
    assert_eq!(
        authority.apply(stale_revision).unwrap_err().code,
        CoreErrorCodeV1::StaleRevision
    );

    let mut stale_generation = action(&authority, "stale-generation", 5, StudyCommandV1::Advance);
    stale_generation.authority_generation += 1;
    assert_eq!(
        authority.apply(stale_generation).unwrap_err().code,
        CoreErrorCodeV1::StaleGeneration
    );

    let mut wrong_run = action(&authority, "wrong-run", 5, StudyCommandV1::Advance);
    wrong_run.run_id = "another-run".to_owned();
    assert_eq!(
        authority.apply(wrong_run).unwrap_err().code,
        CoreErrorCodeV1::RunMismatch
    );

    let mut wrong_phase = action(&authority, "wrong-phase", 5, StudyCommandV1::Advance);
    wrong_phase.precondition.expected_phase = RunPhaseV1::Paused;
    assert_eq!(
        authority.apply(wrong_phase).unwrap_err().code,
        CoreErrorCodeV1::PhasePreconditionFailed
    );

    let mut wrong_block = action(&authority, "wrong-block", 5, StudyCommandV1::Advance);
    wrong_block.precondition.expected_block_id = Some("other-block".to_owned());
    assert_eq!(
        authority.apply(wrong_block).unwrap_err().code,
        CoreErrorCodeV1::BlockPreconditionFailed
    );

    let regressed = action(&authority, "regressed-time", 3, StudyCommandV1::Advance);
    assert_eq!(
        authority.apply(regressed).unwrap_err().code,
        CoreErrorCodeV1::TimeRegression
    );
    assert_eq!(authority.state(), &original);
}

#[test]
fn questionnaires_commit_complete_answers_once_and_gate_advancement() {
    let mut authority = authority();
    prepare_and_start(&mut authority);
    apply(
        &mut authority,
        "advance-instruction",
        5,
        StudyCommandV1::Advance,
    );

    let before_invalid_sample = authority.state().clone();
    let rejected = action(
        &authority,
        "sample-introduction",
        6,
        StudyCommandV1::RecordAffectSample { sample: sample() },
    );
    assert_eq!(
        authority.apply(rejected).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );
    assert_eq!(authority.state(), &before_invalid_sample);

    apply(
        &mut authority,
        "advance-intro-video",
        7,
        StudyCommandV1::Advance,
    );
    assert_eq!(
        authority.state().current_block_id.as_deref(),
        Some("preflight-form")
    );

    let premature = action(&authority, "premature", 8, StudyCommandV1::Advance);
    assert_eq!(
        authority.apply(premature).unwrap_err().code,
        CoreErrorCodeV1::IncompleteQuestionnaire
    );

    let incomplete = action(
        &authority,
        "incomplete-form",
        8,
        StudyCommandV1::SubmitQuestionnaire {
            questionnaire_id: "preflight".to_owned(),
            answers: vec![],
        },
    );
    assert_eq!(
        authority.apply(incomplete).unwrap_err().code,
        CoreErrorCodeV1::IncompleteQuestionnaire
    );

    let outcome = apply(
        &mut authority,
        "complete-form",
        8,
        StudyCommandV1::SubmitQuestionnaire {
            questionnaire_id: "preflight".to_owned(),
            answers: complete_answers(),
        },
    );
    assert_eq!(outcome.events.len(), 1);
    assert!(matches!(
        outcome.events[0].payload,
        RunEventPayloadV1::QuestionnaireSubmitted { .. }
    ));

    let duplicate = action(
        &authority,
        "duplicate-form",
        9,
        StudyCommandV1::SubmitQuestionnaire {
            questionnaire_id: "preflight".to_owned(),
            answers: complete_answers(),
        },
    );
    assert_eq!(
        authority.apply(duplicate).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );
    apply(&mut authority, "advance-form", 9, StudyCommandV1::Advance);
    assert_eq!(
        authority.state().current_block_id.as_deref(),
        Some("stim-c-video")
    );
}

#[test]
fn affect_samples_require_an_active_collecting_video() {
    let mut authority = authority();
    prepare_and_start(&mut authority);
    apply(&mut authority, "a1", 5, StudyCommandV1::Advance);
    apply(&mut authority, "a2", 6, StudyCommandV1::Advance);
    apply(
        &mut authority,
        "questionnaire",
        7,
        StudyCommandV1::SubmitQuestionnaire {
            questionnaire_id: "preflight".to_owned(),
            answers: complete_answers(),
        },
    );
    apply(&mut authority, "a3", 8, StudyCommandV1::Advance);

    let no_clock = action(
        &authority,
        "sample-no-clock",
        9,
        StudyCommandV1::RecordAffectSample { sample: sample() },
    );
    assert_eq!(
        authority.apply(no_clock).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );

    apply(
        &mut authority,
        "timeline",
        9,
        StudyCommandV1::ReportMediaTimeline {
            anchor: MediaTimelineAnchorV1 {
                media_position_ms: 250,
                observed_monotonic_ms: 9,
                playing: true,
                playback_rate: 1.0,
            },
        },
    );
    let sample_outcome = apply(
        &mut authority,
        "sample",
        10,
        StudyCommandV1::RecordAffectSample { sample: sample() },
    );
    assert!(matches!(
        sample_outcome.events[0].payload,
        RunEventPayloadV1::AffectSampleRecorded { .. }
    ));

    apply(
        &mut authority,
        "pause",
        11,
        StudyCommandV1::Pause {
            reason_code: "researcher-pause".to_owned(),
        },
    );
    assert!(
        !authority
            .state()
            .media_timeline_anchor
            .as_ref()
            .unwrap()
            .playing
    );
    let paused_sample = action(
        &authority,
        "paused-sample",
        12,
        StudyCommandV1::RecordAffectSample { sample: sample() },
    );
    assert_eq!(
        authority.apply(paused_sample).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );
}

#[test]
fn identical_actions_produce_byte_identical_native_outcomes() {
    let mut left = authority();
    let mut right = authority();
    for (id, time, command) in [
        ("prepare", 1, StudyCommandV1::Prepare),
        (
            "settings",
            2,
            StudyCommandV1::ApplyPinnedSettings {
                settings_sha256: Sha256HexV1(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                ),
            },
        ),
        ("arm", 3, StudyCommandV1::Arm),
        ("start", 4, StudyCommandV1::Start),
        ("advance", 5, StudyCommandV1::Advance),
    ] {
        let left_outcome = left
            .apply(action(&left, id, time, command.clone()))
            .unwrap();
        let right_outcome = right.apply(action(&right, id, time, command)).unwrap();
        assert_eq!(
            serde_json::to_vec(&left_outcome).unwrap(),
            serde_json::to_vec(&right_outcome).unwrap()
        );
    }
}

#[test]
fn complete_run_reaches_finalization_without_losing_block_events() {
    let mut authority = authority();
    let mut events = prepare_and_start(&mut authority);
    let mut monotonic_ms = 5;

    while authority.state().phase == RunPhaseV1::Running {
        if matches!(
            authority.current_block(),
            Some(StudyBlockV1::Questionnaire { .. })
        ) {
            events.extend(
                apply(
                    &mut authority,
                    "questionnaire-loop",
                    monotonic_ms,
                    StudyCommandV1::SubmitQuestionnaire {
                        questionnaire_id: "preflight".to_owned(),
                        answers: complete_answers(),
                    },
                )
                .events,
            );
            monotonic_ms += 1;
        }
        events.extend(
            apply(
                &mut authority,
                "advance-loop",
                monotonic_ms,
                StudyCommandV1::Advance,
            )
            .events,
        );
        monotonic_ms += 1;
    }

    assert_eq!(authority.state().phase, RunPhaseV1::AwaitingFinalization);
    assert!(authority.state().current_block_id.is_none());
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, RunEventPayloadV1::BlockEntered))
            .count(),
        10
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, RunEventPayloadV1::BlockCompleted))
            .count(),
        10
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=events.len() as u64).collect::<Vec<_>>()
    );

    let final_outcome = apply(
        &mut authority,
        "finalize",
        monotonic_ms,
        StudyCommandV1::Finalize,
    );
    assert_eq!(final_outcome.state.phase, RunPhaseV1::Completed);
    assert_eq!(
        final_outcome.state.completion_status,
        Some(CompletionStatusV1::Completed)
    );
    assert!(matches!(
        final_outcome.events[0].payload,
        RunEventPayloadV1::RunFinalized
    ));
}

#[test]
fn true_branch_emits_a_decision_before_entering_the_conditional_trial() {
    let mut authority = authority();
    let outcome = reach_conditional_trial(&mut authority, answers_with_handedness("right"));

    assert_eq!(
        outcome.state.current_block_id.as_deref(),
        Some("condition-b-instruction")
    );
    assert_eq!(outcome.events.len(), 3);
    let decision = &outcome.events[1];
    assert_eq!(decision.section_id.as_deref(), Some("williams"));
    assert_eq!(decision.trial_id.as_deref(), Some("condition-b"));
    assert!(decision.block_id.is_none());
    assert!(matches!(
        &decision.payload,
        RunEventPayloadV1::TrialBranchDecided {
            eligible: true,
            observed_answer: QuestionnaireAnswerV1::SingleChoice { option_id, .. },
            ..
        } if option_id == "right"
    ));
    assert!(matches!(
        outcome.events[2].payload,
        RunEventPayloadV1::BlockEntered
    ));
    assert_eq!(
        outcome.events[2].block_id.as_deref(),
        Some("condition-b-instruction")
    );
}

#[test]
fn false_branch_has_unambiguous_decision_skip_and_next_entry_sequences() {
    let mut authority = authority();
    let outcome = reach_conditional_trial(&mut authority, answers_with_handedness("left"));

    assert_eq!(
        outcome.state.current_block_id.as_deref(),
        Some("condition-c-break")
    );
    assert_eq!(outcome.events.len(), 4);
    let decision = &outcome.events[1];
    let skipped = &outcome.events[2];
    let entered = &outcome.events[3];
    assert!(matches!(
        decision.payload,
        RunEventPayloadV1::TrialBranchDecided {
            eligible: false,
            ..
        }
    ));
    assert!(matches!(
        skipped.payload,
        RunEventPayloadV1::TrialSkipped {
            reason: TrialSkipReasonV1::RunIfFalse
        }
    ));
    assert_eq!(decision.sequence + 1, skipped.sequence);
    assert_eq!(skipped.sequence + 1, entered.sequence);
    assert_eq!(skipped.section_id.as_deref(), Some("williams"));
    assert_eq!(skipped.trial_id.as_deref(), Some("condition-b"));
    assert!(skipped.block_id.is_none());
    assert!(matches!(entered.payload, RunEventPayloadV1::BlockEntered));
    assert_eq!(entered.trial_id.as_deref(), Some("condition-c"));
    assert_eq!(entered.block_id.as_deref(), Some("condition-c-break"));
    assert!(outcome
        .events
        .windows(2)
        .all(|pair| pair[1].sequence == pair[0].sequence + 1));
    let golden: Vec<RunEventV1> =
        serde_json::from_str(include_str!("../fixtures/branch-events-v1.json")).unwrap();
    assert_eq!(&outcome.events[1..3], golden.as_slice());
}

#[test]
fn multiple_choice_membership_uses_the_same_authoritative_branch_path() {
    let mut study = support::draft_study();
    study.sections[2].trials[1].run_if = Some(TrialRunConditionV1::Contains {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "familiarity".to_owned(),
        option_id: "vr".to_owned(),
    });
    let study = study.published().unwrap();
    let configuration = support::run_configuration();
    let mut authority = StudyAuthorityV1::new(study, configuration, 7).unwrap();
    let outcome = reach_conditional_trial(&mut authority, complete_answers());
    assert!(matches!(
        outcome.events[1].payload,
        RunEventPayloadV1::TrialBranchDecided { eligible: true, .. }
    ));
    assert_eq!(
        outcome.state.current_trial_id.as_deref(),
        Some("condition-b")
    );
}

#[test]
fn calibration_and_adapter_health_gate_arming() {
    let mut study = support::draft_study();
    study.pinned_settings.acquisition.reset_policy = AffectResetPolicyV1::RequireCalibration;
    let study = study.published().unwrap();
    let configuration = support::run_configuration();
    let mut authority = StudyAuthorityV1::new(study, configuration, 8).unwrap();

    apply(&mut authority, "prepare", 1, StudyCommandV1::Prepare);
    let settings_sha256 = authority
        .study()
        .pinned_settings
        .portable_settings_sha256
        .clone();
    apply(
        &mut authority,
        "settings",
        2,
        StudyCommandV1::ApplyPinnedSettings { settings_sha256 },
    );
    let missing_calibration = action(&authority, "arm-too-soon", 3, StudyCommandV1::Arm);
    assert_eq!(
        authority.apply(missing_calibration).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );

    apply(
        &mut authority,
        "calibrate",
        3,
        StudyCommandV1::SetAffectCalibration {
            point: AffectPointV1 {
                valence: 0.1,
                arousal: -0.1,
            },
        },
    );
    apply(
        &mut authority,
        "health-down",
        4,
        StudyCommandV1::ReportHealth {
            health: RunHealthV1 {
                storage: HealthComponentV1 {
                    status: HealthStatusV1::Unavailable,
                    detail_code: Some("quota".to_owned()),
                },
                input: HealthComponentV1 {
                    status: HealthStatusV1::Ready,
                    detail_code: None,
                },
                lsl: HealthComponentV1 {
                    status: HealthStatusV1::Unavailable,
                    detail_code: Some("not-required".to_owned()),
                },
            },
        },
    );
    let unhealthy = action(&authority, "arm-unhealthy", 5, StudyCommandV1::Arm);
    assert_eq!(
        authority.apply(unhealthy).unwrap_err().code,
        CoreErrorCodeV1::InvalidTransition
    );

    let mut ready = authority.state().health.clone();
    ready.storage = HealthComponentV1 {
        status: HealthStatusV1::Ready,
        detail_code: None,
    };
    apply(
        &mut authority,
        "health-ready",
        5,
        StudyCommandV1::ReportHealth { health: ready },
    );
    apply(&mut authority, "arm", 6, StudyCommandV1::Arm);
    assert_eq!(authority.state().phase, RunPhaseV1::Armed);
}
