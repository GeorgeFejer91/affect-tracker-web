#![allow(dead_code)]

use affect_tracker_study_core::*;

pub fn draft_study() -> StudyDefinitionV1 {
    serde_json::from_str(include_str!("../../fixtures/study-v1.json"))
        .expect("study fixture must deserialize")
}

pub fn published_study() -> StudyDefinitionV1 {
    draft_study()
        .published()
        .expect("study fixture must publish")
}

pub fn run_configuration() -> RunConfigurationV1 {
    serde_json::from_str(include_str!("../../fixtures/run-configuration-v1.json"))
        .expect("run configuration fixture must deserialize")
}

pub fn authority() -> StudyAuthorityV1 {
    StudyAuthorityV1::new(published_study(), run_configuration(), 7)
        .expect("fixture authority must initialize")
}

pub fn action(
    authority: &StudyAuthorityV1,
    action_id: &str,
    monotonic_ms: u64,
    command: StudyCommandV1,
) -> StudyActionV1 {
    StudyActionV1 {
        schema: STUDY_ACTION_SCHEMA_V1.to_owned(),
        version: CONTRACT_VERSION_V1,
        action_id: action_id.to_owned(),
        run_id: authority.state().run_id.clone(),
        authority_generation: authority.state().authority_generation,
        expected_revision: authority.state().revision,
        precondition: ActionPreconditionV1 {
            expected_phase: authority.state().phase,
            expected_block_id: authority.state().current_block_id.clone(),
        },
        clock: EventClockV1 {
            monotonic_ms,
            wall_time_utc: format!("2026-09-03T12:00:{:02}Z", monotonic_ms % 60),
        },
        command,
    }
}

pub fn complete_answers() -> Vec<QuestionnaireAnswerV1> {
    vec![
        QuestionnaireAnswerV1::Acknowledgement {
            item_id: "consent".to_owned(),
            acknowledged: true,
        },
        QuestionnaireAnswerV1::SingleChoice {
            item_id: "handedness".to_owned(),
            option_id: "right".to_owned(),
        },
        QuestionnaireAnswerV1::MultipleChoice {
            item_id: "familiarity".to_owned(),
            option_ids: vec!["desktop".to_owned(), "vr".to_owned()],
        },
        QuestionnaireAnswerV1::Likert {
            item_id: "clarity".to_owned(),
            value: 6,
        },
        QuestionnaireAnswerV1::Vas {
            item_id: "comfort".to_owned(),
            value: 72.5,
        },
        QuestionnaireAnswerV1::Numeric {
            item_id: "age".to_owned(),
            value: 34.0,
        },
        QuestionnaireAnswerV1::Affect2d {
            item_id: "baseline-affect".to_owned(),
            valence: 0.2,
            arousal: -0.3,
        },
    ]
}

pub fn apply(
    authority: &mut StudyAuthorityV1,
    action_id: &str,
    monotonic_ms: u64,
    command: StudyCommandV1,
) -> ReducerOutcomeV1 {
    let next_action = action(authority, action_id, monotonic_ms, command);
    authority
        .apply(next_action)
        .expect("fixture action must succeed")
}

pub fn prepare_and_start(authority: &mut StudyAuthorityV1) -> Vec<RunEventV1> {
    let mut events = Vec::new();
    events.extend(apply(authority, "prepare", 1, StudyCommandV1::Prepare).events);
    let settings_sha256 = authority
        .study()
        .pinned_settings
        .portable_settings_sha256
        .clone();
    events.extend(
        apply(
            authority,
            "settings",
            2,
            StudyCommandV1::ApplyPinnedSettings { settings_sha256 },
        )
        .events,
    );
    events.extend(apply(authority, "arm", 3, StudyCommandV1::Arm).events);
    events.extend(apply(authority, "start", 4, StudyCommandV1::Start).events);
    events
}
